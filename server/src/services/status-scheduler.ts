/**
 * 实例状态同步调度器 (高可用优化版)
 * 
 * 优化特性：
 * 1. 增量同步：优先同步最近有变化的实例
 * 2. 分批处理：避免一次性处理所有实例，降低宿主机压力
 * 3. 优先级队列：running 状态的实例优先同步
 * 4. 健康检查：监控宿主机响应时间，自动降级
 * 5. 连接池复用：使用统一的 Incus 连接池
 */

import { schedule } from 'node-cron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pLimit from 'p-limit'
import { prisma } from '../db/prisma.js'
import { getIncusClient } from '../lib/incus/incus-pool.js'
import { IncusClient } from '../lib/incus/incus-client.js'
import { isHostHealthy, recordHostSuccess, recordHostError, getAllHostHealth } from '../lib/incus/host-health.js'
import { getInstanceState } from '../lib/incus/incus-instances.js'
import { mapInstanceStatus } from '../lib/incus/incus-utils.js'
import { sendNotification } from '../lib/notifier.js'
import * as db from '../db/index.js'
import { createLog } from '../db/logs.js'

// ==================== 配置常量 ====================

// 每个宿主机的并发限制
const CONCURRENCY_PER_HOST = 20

// 每批处理的实例数量
const BATCH_SIZE = 50

// 任务超时时间 (5分钟)
const JOB_TIMEOUT_MS = 5 * 60 * 1000

// 单个实例同步超时 (10秒)
const INSTANCE_TIMEOUT_MS = 10 * 1000

// 同步间隔：running 实例 2 分钟，stopped 实例 10 分钟
const SYNC_INTERVAL_RUNNING_MS = 2 * 60 * 1000
const SYNC_INTERVAL_STOPPED_MS = 10 * 60 * 1000

// 任务运行状态标志
let isJobRunning = false

// 节点连通性检查超时（12秒）
const HOST_PING_TIMEOUT_MS = 12 * 1000

// 用于第一级 nc 探测
const execFileAsync = promisify(execFile)

// 第一级 TCP 探测超时（5秒）
const HOST_TCP_TIMEOUT_MS = 5 * 1000

// 连续失败多少轮才判离线/异常（配合 5 分钟一轮 → 最慢 10 分钟变红）
const HOST_FAIL_THRESHOLD = 2

/**
 * 节点连通性检查专用的连续失败计数。
 *
 * 不要复用 host-health.ts 里的 errorCount：那里有个 5 分钟冷却重置，
 * 而实例同步（1 分钟）、流量采集（3 分钟）都会调 isHostHealthy()，
 * 计数器被反复清零，在线节点掉线后永远攒不满 3 次 → 永远判不到离线
 * （踩过：HK-BGP 挂了 2 小时面板仍显示在线）。
 */
const hostCheckFailures = new Map<number, { tcp: number; api: number }>()

// ==================== 节点连通性检查 ====================

/**
 * 第一级：nc TCP 探测（与运维手工 `nc -z -w 3 ip 8443` 完全一致）。
 * 端口固定 8443；连不上 → 节点一定不可用，直接判离线，不用再走 API。
 */
async function tcpProbe(host: string, timeoutMs: number): Promise<void> {
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000))
    try {
        await execFileAsync('nc', ['-z', '-w', String(secs), host, '8443'], {
            timeout: timeoutMs + 2000
        })
    } catch {
        throw new Error(`TCP 不通（nc -z -w ${secs} ${host} 8443）`)
    }
}

/**
 * 检查所有节点的连通性并同步 hosts.status。
 *
 * 背景：此前项目里没有任何一处会把节点置为 offline —— hosts.status 只在
 * 安装/连接成功时被写成 online，掉线后永远停留在 online。后果有两个：
 *   1. 节点列表一直显示「在线」；
 *   2. 本调度器只处理 host.status='online' 的实例，掉线节点上的实例
 *      永远同步不到，用户端一直显示「运行中」。
 */
async function checkHostsConnectivity(): Promise<void> {
    const hosts = await prisma.host.findMany({
        where: { isInstalled: true, status: { not: 'maintenance' } },
        select: { id: true, name: true, status: true, location: true }
    })

    if (hosts.length === 0) return

    const limit = pLimit(8)

    await Promise.all(
        hosts.map(host =>
            limit(async () => {
                const start = Date.now()
                let tcpOk = false
                try {
                    const full = await db.getHostById(host.id)
                    if (!full) return
                    // 直连 new IncusClient（不走连接池）：33 台并发时连接池会排队，
                    // 排队时间会被算进超时，导致后面的节点集体误判（踩过一次）。
                    if (!full.url) return

                    // 第一级：nc TCP 探测（端口固定 8443）——连不上就一定不可用，不用再走 API
                    const parsed = new URL(full.url)
                    await tcpProbe(
                        parsed.hostname.replace(/^\[|\]$/g, ''),
                        HOST_TCP_TIMEOUT_MS
                    )
                    tcpOk = true

                    // 无证书（节点尚未完成「验证并连接」）：只做 TCP 探测。
                    // 否则这些节点会被整段跳过，状态永远冻结在 online（节点已删除也不会变离线）。
                    if (!full.cert_path || !full.key_path) {
                        recordHostSuccess(host.id, Date.now() - start)
                        return
                    }

                    // 第二级：Incus API 握手（能抓到「端口通但服务不可用」这种假在线）
                    const client = new IncusClient({
                        url: full.url,
                        certPath: full.cert_path,
                        keyPath: full.key_path
                    })
                    try {
                        await withTimeout(
                            client.connect() as Promise<unknown>,
                            HOST_PING_TIMEOUT_MS,
                            'Host ping timeout'
                        )
                    } finally {
                        await client.close().catch(() => { /* 关闭失败忽略 */ })
                    }

                    // 两级都通过 → 在线
                    recordHostSuccess(host.id, Date.now() - start)
                    hostCheckFailures.delete(host.id)

                    if (host.status !== 'online') {
                        await db.updateHostStatus(host.id, 'online')
                        console.log(`[HostCheck] ${host.name} 恢复在线`)
                        // 写事件：机器人从 /api/bot/hosts/events 拉取后推到守护群
                        await createLog(
                            null,
                            'system',
                            'host.status_online',
                            `节点恢复在线：${host.name}${host.location ? `（${host.location}）` : ''}`,
                            'success'
                        ).catch(() => { /* 日志失败不影响主流程 */ })
                    }
                } catch (error) {
                    recordHostError(host.id)

                    // 本检查器自己的连续失败计数（tcp 失败 = 离线，api 失败 = 异常）
                    const prev = hostCheckFailures.get(host.id) ?? { tcp: 0, api: 0 }
                    const fails = tcpOk ? prev.api + 1 : prev.tcp + 1
                    hostCheckFailures.set(host.id, {
                        tcp: tcpOk ? 0 : prev.tcp + 1,
                        api: tcpOk ? prev.api + 1 : 0
                    })

                    // 连续失败达到阈值才处理，避免网络抖动误判；
                    // 但节点【本来就是非在线状态】时不用再等（它已经不在线了，
                    // 这里只是把 offline/abnormal 精修成正确的那个）。
                    const alreadyDown = host.status === 'offline' || host.status === 'abnormal'
                    if (fails >= HOST_FAIL_THRESHOLD || alreadyDown) {
                        // 第一级 nc 通过、第二级 API 失败 → 异常（端口通但服务不可用）
                        // 第一级 nc 就失败 → 离线（真连不上）
                        const nextStatus: 'abnormal' | 'offline' = tcpOk ? 'abnormal' : 'offline'
                        if (host.status !== nextStatus) {
                            await db.updateHostStatus(host.id, nextStatus)
                            const reason = (error instanceof Error ? error.message : String(error)).slice(0, 100)
                            console.log(`[HostCheck] ${host.name} 判定${tcpOk ? '异常' : '离线'}：${reason}`)
                            // 写事件：机器人从 /api/bot/hosts/events 拉取后推到守护群
                            await createLog(
                                null,
                                'system',
                                tcpOk ? 'host.status_abnormal' : 'host.status_offline',
                                `节点${tcpOk ? '异常' : '离线'}：${host.name}${host.location ? `（${host.location}）` : ''}`,
                                'partial'
                            ).catch(() => { /* 日志失败不影响主流程 */ })
                        }
                    }
                }
            })
        )
    )
}

// ==================== 性能监控 ====================

interface SyncStats {
    totalChecked: number
    totalChanged: number
    totalErrors: number
    hostStats: Map<number, { checked: number; changed: number; avgResponseTime: number }>
}

let lastSyncStats: SyncStats | null = null

export function getSyncStats(): SyncStats | null {
    return lastSyncStats
}

// ==================== 工具函数 ====================

/**
 * 带超时的 Promise
 */
async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    })

    try {
        return await Promise.race([promise, timeoutPromise])
    } finally {
        if (timeoutId) clearTimeout(timeoutId)
    }
}

// ==================== 核心同步逻辑 ====================

/**
 * 获取需要同步的实例（优化版：增量 + 优先级）
 */
async function getInstancesToSync(batchSize: number) {
    const now = Date.now()

    // 获取需要同步的实例，按优先级排序：
    // 1. running 状态的实例优先
    // 2. 最近未同步的实例优先
    // 注意：不同步 creating 状态的实例，避免与超时清理和 createInstanceAsync 竞争
    const instances = await prisma.instance.findMany({
        where: {
            status: {
                in: ['running', 'stopped']  // 不包含 creating，避免竞争
            },
            host: {
                status: 'online'
            }
        },
        include: {
            host: {
                select: {
                    id: true,
                    name: true,
                    url: true,
                    certPath: true,
                    keyPath: true,
                    status: true
                }
            },
            user: {
                select: {
                    id: true
                }
            }
        },
        orderBy: [
            // running 状态优先
            { status: 'asc' },
            // 最近更新的优先（可能有状态变化）
            { updatedAt: 'desc' }
        ],
        take: batchSize * 3  // 多取一些，后面会过滤
    })

    // 根据上次同步时间过滤
    const needSync = instances.filter(instance => {
        // 优先使用 lastSyncedAt，回退到 updatedAt
        const lastSync = (instance.lastSyncedAt ?? instance.updatedAt).getTime()
        const interval = instance.status === 'running'
            ? SYNC_INTERVAL_RUNNING_MS
            : SYNC_INTERVAL_STOPPED_MS

        // 如果距离上次同步超过同步间隔，需要同步
        return now - lastSync > interval
    })

    // 返回指定数量
    return needSync.slice(0, batchSize)
}

/**
 * 同步单个实例状态
 */
async function syncInstanceStatus(
    instance: {
        id: number
        incusId: string
        name: string
        status: string
        host: {
            id: number
            name: string
            url: string
            certPath: string | null
            keyPath: string | null
        }
        user: { id: number }
    }
): Promise<{ changed: boolean; from?: string; to?: string; error?: string }> {
    const startTime = Date.now()

    try {
        // 检查宿主机健康状态
        if (!isHostHealthy(instance.host.id)) {
            return { changed: false, error: 'Host unhealthy, skipped' }
        }

        const host = await db.getHostById(instance.host.id)
        if (!host) {
            return { changed: false, error: 'Host not found' }
        }

        const client = await getIncusClient(host)

        const state = await withTimeout(
            getInstanceState(client, instance.incusId) as Promise<{ status?: string }>,
            INSTANCE_TIMEOUT_MS,
            'Instance state query timeout'
        )

        const responseTime = Date.now() - startTime
        recordHostSuccess(instance.host.id, responseTime)

        if (!state.status) {
            return { changed: false }
        }

        const incusStatus = mapInstanceStatus(state.status)

        if (incusStatus === 'unknown') {
            return { changed: false }
        }

        // 状态不一致，需要更新
        if (instance.status !== incusStatus) {
            await db.updateInstanceStatus(
                instance.id,
                incusStatus as 'creating' | 'running' | 'stopped' | 'error'
            )
            
            // 同时更新 lastSyncedAt
            await prisma.instance.updateMany({
                where: {
                    id: instance.id,
                    status: { not: 'deleted' }
                },
                data: { lastSyncedAt: new Date() }
            })

            // 如果是从 running 变为 stopped，发送意外停机通知
            if (instance.status === 'running' && incusStatus === 'stopped') {
                try {
                    await sendNotification(instance.user.id, 'instance_unexpected_stop', {
                        instanceName: instance.name,
                        hostName: instance.host.name
                    })
                } catch (notifyError) {
                    console.error(`[StatusSync] Failed to send notification:`, notifyError)
                }
            }

            return {
                changed: true,
                from: instance.status,
                to: incusStatus
            }
        }

        // 状态相同，更新 lastSyncedAt 记录同步时间
        await prisma.instance.updateMany({
            where: {
                id: instance.id,
                status: { not: 'deleted' }
            },
            data: { lastSyncedAt: new Date() }
        })

        return { changed: false }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        recordHostError(instance.host.id)

        // 如果实例不存在于 Incus，标记为已删除
        if (errorMessage.includes('not found') || errorMessage.includes('Instance not found')) {
            console.log(`[StatusSync] Instance ${instance.id} not found in Incus, marking as deleted`)
            await db.updateInstanceStatus(instance.id, 'deleted')
            return {
                changed: true,
                from: instance.status,
                to: 'deleted'
            }
        }

        return { changed: false, error: errorMessage }
    }
}

/**
 * 执行状态同步任务
 */
async function executeStatusSyncJob(): Promise<void> {
    const startTime = Date.now()
    const stats: SyncStats = {
        totalChecked: 0,
        totalChanged: 0,
        totalErrors: 0,
        hostStats: new Map()
    }

    // 获取需要同步的实例
    const instances = await getInstancesToSync(BATCH_SIZE)

    if (instances.length === 0) {
        console.log('[StatusSync] No instances need sync')
        return
    }

    console.log(`[StatusSync] Processing ${instances.length} instances...`)

    // 按宿主机分组
    const instancesByHost = new Map<number, typeof instances>()
    for (const instance of instances) {
        const hostInstances = instancesByHost.get(instance.host.id) || []
        hostInstances.push(instance)
        instancesByHost.set(instance.host.id, hostInstances)
    }

    // 并发处理每个宿主机
    const limit = pLimit(CONCURRENCY_PER_HOST)

    await Promise.all(
        Array.from(instancesByHost.entries()).map(async ([hostId, hostInstances]) => {
            const hostStartTime = Date.now()
            let hostChecked = 0
            let hostChanged = 0

            // 并发同步该宿主机上的所有实例
            await Promise.all(
                hostInstances.map(instance =>
                    limit(async () => {
                        const result = await syncInstanceStatus(instance)
                        hostChecked++
                        if (result.changed) {
                            hostChanged++
                            console.log(`[StatusSync] Instance ${instance.id} (${instance.name}): ${result.from} → ${result.to}`)
                        }
                        if (result.error) {
                            stats.totalErrors++
                        }
                        return result
                    })
                )
            )

            const hostDuration = Date.now() - hostStartTime
            stats.hostStats.set(hostId, {
                checked: hostChecked,
                changed: hostChanged,
                avgResponseTime: hostChecked > 0 ? hostDuration / hostChecked : 0
            })

            stats.totalChecked += hostChecked
            stats.totalChanged += hostChanged
        })
    )

    const duration = Date.now() - startTime
    lastSyncStats = stats

    console.log(`[StatusSync] Completed in ${duration}ms: checked=${stats.totalChecked}, changed=${stats.totalChanged}, errors=${stats.totalErrors}`)
}

/**
 * 主状态同步任务
 */
export async function runStatusSyncJob(): Promise<void> {
    if (isJobRunning) {
        console.log('[StatusSync] Previous job still running, skipping...')
        return
    }

    isJobRunning = true

    try {
        await withTimeout(
            executeStatusSyncJob(),
            JOB_TIMEOUT_MS,
            `[StatusSync] Job timeout after ${JOB_TIMEOUT_MS}ms`
        )
    } catch (error) {
        if (error instanceof Error && error.message.includes('timeout')) {
            console.error(`[StatusSync] Job timed out`)
        } else {
            console.error('[StatusSync] Job failed:', error)
        }
    } finally {
        isJobRunning = false
    }
}

/**
 * 启动状态同步调度器
 */
export function startStatusScheduler(): void {
    // 实例状态同步：每 1 分钟轮询一次
    // （实际同步间隔由 getInstancesToSync 控制：running 实例 2 分钟、stopped 实例 10 分钟）
    schedule('*/1 * * * *', () => {
        runStatusSyncJob().catch(console.error)
    })

    // 节点连通性检查：每 5 分钟一次，与实例同步解耦
    // 判离线需连续 2 次失败 → 掉线后约 10 分钟内面板显示「离线」
    // 恢复在线只需 1 次成功 → 最慢 5 分钟
    schedule('*/5 * * * *', () => {
        checkHostsConnectivity().catch((error) =>
            console.error('[HostCheck] 节点连通性检查失败:', error)
        )
    })

    console.log('[StatusSync] Scheduler started (instance sync: 1 min poll / running 2 min / stopped 10 min; host connectivity check: every 5 min)')
}

/**
 * 获取宿主机健康状态
 */
export function getHostHealthStatus(): Map<number, {
    lastResponseTime: number
    errorCount: number
    healthy: boolean
}> {
    const result = new Map()
    for (const [hostId, health] of getAllHostHealth()) {
        result.set(hostId, {
            lastResponseTime: health.lastResponseTime,
            errorCount: health.errorCount,
            healthy: isHostHealthy(hostId)
        })
    }
    return result
}
