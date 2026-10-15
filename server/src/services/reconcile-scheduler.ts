/**
 * 一致性对账调度器
 *
 * 解决的问题（历史上产生「幽灵」的根因）：
 *   1. 幽灵容器：节点上还在跑，面板数据库里已经查不到（或已是 deleted）
 *      → 它的端口代理设备继续占着端口，而数据库里没有记录
 *      → 面板分配端口时以为空闲，分给新实例 → 新实例起不来
 *   2. 缺失容器：数据库里状态正常，节点上其实没有
 *   3. 旧版代理设备：proxy-v6-<proto>-<port>（listen=[::]:port，通配所有 IPv6）
 *      与新版 proxy-<proto>-<port>-v6（listen=[具体公网IPv6]:port）冲突
 *      → 容器启动/重建报 "Failed to listen on [::]:<port>"
 *
 * 安全设计（避免误删用户容器 / 避免拖垮不稳的节点）：
 *   - 所有节点操作都有独立超时；单个操作超时 → 立即放弃该节点本轮剩余操作
 *   - 幽灵容器必须【连续两轮】都被观察到才会删除（避免和正在创建/删除的实例抢跑）
 *   - 只处理名字符合面板命名规范（u<数字>-<字母数字>）的容器
 *   - 任何异常只记录日志，绝不抛出影响主进程
 */

import { schedule } from 'node-cron'
import { prisma } from '../db/prisma.js'
import { getIncusClient, listInstances, removeDevice, addDevice, stopInstance, deleteInstance } from '../lib/incus/index.js'
import { calculateHostResourcesFromInstances, updateHostResources } from '../db/hosts.js'
import { createLog } from '../db/logs.js'

// ==================== 配置 ====================

/** 对账间隔：每 10 分钟一轮 */
const CRON_EXPR = '*/10 * * * *'

/** 单个节点操作的超时（毫秒）。超时即判定节点不稳，跳过该节点剩余操作 */
const OP_TIMEOUT_MS = 12 * 1000

/** 单个节点的整体超时 */
const HOST_TIMEOUT_MS = 3 * 60 * 1000

/** 面板容器命名规范：u<userId>-<random> */
const PANEL_CONTAINER_RE = /^u\d+-[a-z0-9]+$/i

// ==================== 类型 ====================

interface NodeInstance {
  name: string
  status?: string
  devices?: Record<string, { type?: string; listen?: string; connect?: string }>
}

export interface ReconcileStats {
  startedAt: string
  finishedAt: string
  hostsScanned: number
  hostsSkipped: number
  containersOnNodes: number
  ghostsDeleted: number
  missingMarkedError: number
  legacyDevicesRemoved: number
  legacyDevicesRebuilt: number
  resourcesFixed: number
  errors: string[]
}

// ==================== 运行时状态 ====================

let isRunning = false
let task: { stop: () => void } | null = null

/** 幽灵候选：`hostId/容器名` -> 连续观察到的轮数 */
const ghostStrikes = new Map<string, number>()

let lastStats: ReconcileStats | null = null

export function getReconcileStats(): ReconcileStats | null {
  return lastStats
}

// ==================== 工具 ====================

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`对账超时(${OP_TIMEOUT_MS}ms): ${label}`)), OP_TIMEOUT_MS)
    )
  ])
}

function isTimeoutError(e: unknown): boolean {
  return /超时/.test(e instanceof Error ? e.message : String(e))
}

function normalizeIpv6(v: unknown): string {
  return String(v ?? '').trim().replace(/^\[|\]$/g, '')
}

// ==================== 单节点对账 ====================

async function reconcileHost(host: { id: number; name: string; natPublicIpv6?: string | null }, stats: ReconcileStats): Promise<void> {
  let client: Awaited<ReturnType<typeof getIncusClient>>
  try {
    client = await withTimeout(getIncusClient(host as never), `连接节点 ${host.name}`)
  } catch {
    stats.hostsSkipped++
    return
  }

  let nodeInstances: NodeInstance[]
  try {
    const list = (await withTimeout(listInstances(client), `列出容器 ${host.name}`)) as unknown as NodeInstance[]
    nodeInstances = Array.isArray(list) ? list : []
  } catch {
    stats.hostsSkipped++
    return
  }

  stats.containersOnNodes += nodeInstances.length

  const dbInstances = await prisma.instance.findMany({
    where: { hostId: host.id },
    select: { id: true, incusId: true, status: true, name: true }
  })
  const dbByIncusId = new Map<string, (typeof dbInstances)[number]>()
  for (const i of dbInstances) dbByIncusId.set(String(i.incusId), i)

  // ---------- 1) 幽灵容器 ----------
  for (const ni of nodeInstances) {
    const name = String(ni.name)
    if (!PANEL_CONTAINER_RE.test(name)) continue // 非面板命名的容器，不碰
    const rec = dbByIncusId.get(name)
    const isGhost = !rec || rec.status === 'deleted'
    const key = `${host.id}/${name}`
    if (!isGhost) {
      ghostStrikes.delete(key)
      continue
    }
    const strikes = (ghostStrikes.get(key) || 0) + 1
    ghostStrikes.set(key, strikes)
    if (strikes < 2) {
      console.log(`[Reconcile] ${host.name}/${name} 疑似幽灵（第 ${strikes} 轮），下一轮确认后再处理`)
      continue
    }
    try {
      try {
        await withTimeout(stopInstance(client, name, true), `停止幽灵 ${name}`)
      } catch {
        // 已停止或停不掉，继续删
      }
      await withTimeout(deleteInstance(client, name), `删除幽灵 ${name}`)
      ghostStrikes.delete(key)
      stats.ghostsDeleted++
      const ghostMsg = `已删除幽灵容器 ${host.name}/${name}（节点上有、面板无有效记录）`
      console.log(`[Reconcile] ✓ ${ghostMsg}`)
      await createLog(null, 'system', 'reconcile.ghost_delete', ghostMsg, 'success')
    } catch (e) {
      if (isTimeoutError(e)) {
        stats.errors.push(`${host.name}/${name} 幽灵删除超时，放弃该节点本轮`)
        stats.hostsSkipped++
        return
      }
      stats.errors.push(`${host.name}/${name} 幽灵删除失败: ${String(e).slice(0, 120)}`)
    }
  }

  // ---------- 2) 面板有、节点无（疑似创建失败；只标记不删除，⚠️ 这不是幽灵）----------
  const nodeNames = new Set(nodeInstances.map(x => String(x.name)))
  for (const rec of dbInstances) {
    if (rec.status === 'deleted' || rec.status === 'creating' || rec.status === 'error') continue
    if (nodeNames.has(String(rec.incusId))) continue
    try {
      await prisma.instance.update({ where: { id: rec.id }, data: { status: 'error' } })
      stats.missingMarkedError++
      // ⚠️ 这不是幽灵！幽灵 =「节点上有 · 面板无」；这里是「面板有 · 节点无」，多半是创建失败。
      // 只把状态标记为异常，绝不删容器、也绝不删面板记录。
      const missMsg = `实例 #${rec.id} ${rec.name}（${rec.incusId}）在节点 ${host.name} 上不存在：面板有记录但节点无容器，疑似创建失败，已标记为异常`
      console.log(`[Reconcile] ⚠ ${missMsg}`)
      await createLog(null, 'system', 'reconcile.create_failed', missMsg, 'partial')
    } catch (e) {
      stats.errors.push(`实例 #${rec.id} 标记异常失败: ${String(e).slice(0, 120)}`)
    }
  }

  // ---------- 3) 旧版 proxy-v6-* 设备 ----------
  const hostIpv6 = normalizeIpv6(host.natPublicIpv6)
  for (const ni of nodeInstances) {
    const name = String(ni.name)
    const devices = ni.devices || {}
    const legacy = Object.entries(devices).filter(([dn, v]) => v?.type === 'proxy' && dn.startsWith('proxy-v6-'))
    if (!legacy.length) continue

    const existingNames = new Set(Object.keys(devices))

    for (const [dn, v] of legacy) {
      const listen = String(v.listen || '')
      const portMatch = listen.match(/:(\d+)$/)
      if (!portMatch) continue
      const port = portMatch[1]
      const proto = listen.split(':')[0] || 'tcp'
      const newName = `proxy-${proto}-${port}-v6`
      const hasCounterpart = existingNames.has(newName)
      try {
        await withTimeout(removeDevice(client, name, dn), `删除旧设备 ${name}/${dn}`)
        stats.legacyDevicesRemoved++
        if (!hasCounterpart && hostIpv6) {
          const privatePort = String(v.connect || '').match(/:(\d+)$/)?.[1] || port
          await withTimeout(
            addDevice(client, name, newName, {
              type: 'proxy',
              listen: `${proto}:[${hostIpv6}]:${port}`,
              connect: `${proto}:0.0.0.0:${privatePort}`
            }),
            `重建新设备 ${name}/${newName}`
          )
          stats.legacyDevicesRebuilt++
          const devMsg = `${host.name}/${name} 旧版代理设备 ${dn} → 已重建为 ${newName}（绑定节点公网 IPv6）`
          console.log(`[Reconcile] ✓ ${devMsg}`)
          await createLog(null, 'system', 'reconcile.legacy_device', devMsg, 'success')
        } else {
          const devMsg = `${host.name}/${name} 删除冗余旧版代理设备 ${dn}（该端口已有新格式设备，无需重建）`
          console.log(`[Reconcile] ✓ ${devMsg}`)
          await createLog(null, 'system', 'reconcile.legacy_device', devMsg, 'success')
        }
      } catch (e) {
        if (isTimeoutError(e)) {
          stats.errors.push(`${host.name}/${name}/${dn} 处理超时，放弃该节点本轮`)
          stats.hostsSkipped++
          return
        }
        stats.errors.push(`${host.name}/${name}/${dn} 处理失败: ${String(e).slice(0, 120)}`)
      }
    }
  }

  // ---------- 4) 资源用量与端口计数校正 ----------
  // 面板的 cpu_used / memory_used / disk_used / nat_ports_used_count 是累加计数器：
  // 创建时 +、删除时 -，任何一步失败都会永久漂移（节点重装后容器没了，计数还留着）。
  // 漂移会让 selectAvailableHost 误判「指定宿主机不可用」而拒绝创建实例 —— 必须定期校正。
  try {
    const recalc = await calculateHostResourcesFromInstances(host.id)
    const before = await prisma.host.findUnique({
      where: { id: host.id },
      select: { cpuUsed: true, memoryUsed: true, diskUsed: true, natPortsUsedCount: true }
    })
    await updateHostResources(host.id, {
      cpuUsed: recalc.cpuUsed,
      memoryUsed: recalc.memoryUsed,
      diskUsed: recalc.diskUsed
    })
    // 端口计数同样会漂移，一并校正
    const actualPorts = await prisma.portMapping.count({
      where: { instance: { hostId: host.id, status: { not: 'deleted' } } }
    })
    await prisma.host.update({ where: { id: host.id }, data: { natPortsUsedCount: actualPorts } })

    const cpuChanged = before && before.cpuUsed !== recalc.cpuUsed
    const memChanged = before && before.memoryUsed !== recalc.memoryUsed
    const diskChanged = before && before.diskUsed !== recalc.diskUsed
    const portChanged = before && before.natPortsUsedCount !== actualPorts
    if (cpuChanged || memChanged || diskChanged || portChanged) {
      stats.resourcesFixed++
      // 只列出【真正变化】的项，避免「585%→585%」这种看起来没校正的误导
      const parts: string[] = []
      if (cpuChanged) parts.push(`CPU ${before?.cpuUsed}%→${recalc.cpuUsed}%`)
      if (memChanged) parts.push(`内存 ${before?.memoryUsed}MB→${recalc.memoryUsed}MB`)
      if (diskChanged) parts.push(`硬盘 ${before?.diskUsed}MB→${recalc.diskUsed}MB`)
      if (portChanged) parts.push(`端口 ${before?.natPortsUsedCount}→${actualPorts}`)
      const msg = `${host.name} 资源计数已校正：${parts.join('｜')}`
      console.log(`[Reconcile] 🔧 ${msg}`)
      // 同时写进面板日志表，这样在【面板 → 日志】页面就能看到，不用登机器看 stdout
      await createLog(null, 'system', 'reconcile.resource', msg, 'success')
    }
  } catch (e) {
    stats.errors.push(`${host.name} 资源计数校正失败: ${String(e).slice(0, 120)}`)
  }
}

// ==================== 主流程 ====================

export async function runReconciliation(): Promise<ReconcileStats | null> {
  if (isRunning) {
    console.log('[Reconcile] 上一轮还在跑，跳过本轮')
    return null
  }
  isRunning = true
  const stats: ReconcileStats = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    hostsScanned: 0,
    hostsSkipped: 0,
    containersOnNodes: 0,
    ghostsDeleted: 0,
    missingMarkedError: 0,
    legacyDevicesRemoved: 0,
    legacyDevicesRebuilt: 0,
    resourcesFixed: 0,
    errors: []
  }
  try {
    const hosts = await prisma.host.findMany({ where: { status: 'online' }, orderBy: { id: 'asc' } })
    for (const h of hosts) {
      try {
        await Promise.race([
          reconcileHost({ id: h.id, name: h.name, natPublicIpv6: (h as { natPublicIpv6?: string | null }).natPublicIpv6 }, stats),
          new Promise((_, rej) => setTimeout(() => rej(new Error('节点整体超时')), HOST_TIMEOUT_MS))
        ])
        stats.hostsScanned++
      } catch (e) {
        stats.hostsSkipped++
        stats.errors.push(`${h.name} 对账失败: ${String(e).slice(0, 120)}`)
      }
    }
  } catch (e) {
    stats.errors.push(`对账主流程异常: ${String(e).slice(0, 200)}`)
  } finally {
    stats.finishedAt = new Date().toISOString()
    lastStats = stats
    isRunning = false
  }
  const summary =
    `对账完成：扫描 ${stats.hostsScanned} 节点（跳过 ${stats.hostsSkipped}）｜` +
    `幽灵容器清理 ${stats.ghostsDeleted}（节点有·面板无）｜` +
    `创建失败标记 ${stats.missingMarkedError}（面板有·节点无，只标记不删）｜` +
    `旧版代理设备清理 ${stats.legacyDevicesRemoved}（重建 ${stats.legacyDevicesRebuilt}）｜` +
    `资源校正 ${stats.resourcesFixed}｜错误 ${stats.errors.length}`
  console.log(`[Reconcile] ${summary}`)
  // 只在【有动作或有错误】时写面板日志表，避免每 10 分钟刷一条无意义记录
  const didSomething =
    stats.ghostsDeleted > 0 || stats.missingMarkedError > 0 ||
    stats.legacyDevicesRemoved > 0 || stats.resourcesFixed > 0 || stats.errors.length > 0
  if (didSomething) {
    const detail = stats.errors.length > 0 ? `\n错误：${stats.errors.slice(0, 3).join('；')}` : ''
    try {
      await createLog(null, 'system', 'reconcile.summary', summary + detail, stats.errors.length > 0 ? 'partial' : 'success')
    } catch { /* 日志失败不影响主流程 */ }
  }
  return stats
}

// ==================== 启停 ====================

export function startReconcileScheduler(): void {
  if (task) return
  task = schedule(CRON_EXPR, () => {
    void runReconciliation()
  })
  console.log('🧹 一致性对账调度器已启动（每 10 分钟一轮）')
}

export function stopReconcileScheduler(): void {
  if (task) {
    task.stop()
    task = null
  }
}
