/**
 * 机器人桥接 —— 后台管理模块
 *
 * 对齐魔方插件 tg_points_exchange 的后台菜单：
 *   兑换记录 / 绑定(守护)日志 / 清理记录
 *
 * 与 routes/bot-bridge.ts 的区别：那边是给机器人调的（共享密钥），这边是给面板管理员看的（JWT + 管理员权限）。
 * 持有 BOT_BRIDGE_TOKEN 的人等同管理员，故只读接口对它开放；写接口一律走这里。
 */

import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import * as prisma from '../db/index.js'
import { apiError, ErrorCode } from '../lib/errors.js'
import { createLog } from '../db/logs.js'
import {
  getBotBridgeSettings,
  setBotBridgeToken,
  generateBotBridgeToken,
  getGuardSettings,
  setGuardSettings,
  getTgBindSettings,
  setTgBindSettings
} from '../lib/bot-bridge-config.js'

const PAGE_SIZE_MAX = 100

// 节点国家代码 → 本地化国家名（用 Node 内置 Intl，与面板前端同一套标准）
const countryDisplay = (() => {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }) } catch { return null }
})()
function countryName(code: string | null | undefined): string | null {
  const c = String(code || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return null
  try { return countryDisplay?.of(c) ?? null } catch { return null }
}

const READ_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } }
const CLEANUP_LIMIT = { rateLimit: { max: 6, timeWindow: '1 minute' } }
const WRITE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } }

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function pagination(query: Record<string, string>) {
  const page = toInt(query.page, 1, 1, 10_000)
  const pageSize = toInt(query.pageSize, 20, 1, PAGE_SIZE_MAX)
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

export default async function adminBotBridgeRoutes(app: FastifyInstance) {
  const adminOnly = { onRequest: [app.authenticate, app.requireAdmin] }

  // ==================== 兑换记录 ====================
  // GET /api/admin/bot/records?page=1&pageSize=20&status=&keyword=
  app.get('/api/admin/bot/records', { ...adminOnly, config: READ_LIMIT }, async (request, _reply) => {
    const q = (request.query || {}) as Record<string, string>
    const { page, pageSize, skip, take } = pagination(q)
    const status = String(q.status || '').trim()
    const keyword = String(q.keyword || '').trim().slice(0, 80)

    // 只列「机器人签发的券」：后台「折扣」页生成的公开券（telegramUserId 为空）
    // 有自己的页面，不在这里出现，避免两处记录混在一起。
    const where: Record<string, unknown> = { telegramUserId: { not: null } }
    if (status) where.status = status
    const sceneFilter = String((request.query as any)?.scene || '').trim()
    if (sceneFilter === 'purchase' || sceneFilter === 'renew') where.scene = sceneFilter
    if (keyword) {
      where.OR = [
        { code: { contains: keyword, mode: 'insensitive' as const } },
        { itemName: { contains: keyword, mode: 'insensitive' as const } },
        { telegramUserId: { equals: keyword } },
      ]
    }

    const [items, total] = await Promise.all([
      prisma.prisma.botPromoCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.prisma.botPromoCode.count({ where }),
    ])

    // 兑换记录页要显示「当前绑定的账号」，顺手把这批用户的实例数带出来，避免前端逐个查。
    const userIds = Array.from(new Set(items.map((row) => row.userId)))
    const bindings = userIds.length
      ? await prisma.prisma.userTelegramBinding.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, telegramUserId: true, telegramUsername: true },
        })
      : []
    const bindMap = new Map(bindings.map((b) => [b.userId, b]))

    // 归属快照比对：券上的 TGID / 邮箱与「当前绑定」不一致 → 该券判为异常（核销时会被拒）
    const userRows = userIds.length
      ? await prisma.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, email: true, status: true },
        })
      : []
    const nameMap = new Map(userRows.map((u) => [u.id, u.username ?? null]))
    // 前端「兑换记录」的「用户」列读的是 row.user.username，必须把完整用户对象带出去
    const userDetailMap = new Map(
      userRows.map((u) => [u.id, { id: u.id, username: u.username, email: u.email, status: u.status }])
    )
    const isAbnormal = (row: {
      telegramUserId: string | null
      ownerUsername: string | null
      userId: number
      status: string
    }): boolean => {
      // 后台公开券（无 TGID）无归属，永远正常；已核销/已过期的历史券也不判异常
      if (!row.telegramUserId || row.status !== 'active') return false
      const bind = bindMap.get(row.userId)
      const curTg = bind?.telegramUserId ?? null
      const curName = nameMap.get(row.userId) ?? null
      if (!curTg || String(curTg) !== String(row.telegramUserId)) return true
      if (!row.ownerUsername || !curName || row.ownerUsername !== curName) return true
      return false
    }

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: items.map((row) => ({
        id: row.id,
        code: row.code,
        userId: row.userId,
        telegramUserId: row.telegramUserId ?? bindMap.get(row.userId)?.telegramUserId ?? null,
        telegramUsername: bindMap.get(row.userId)?.telegramUsername ?? null,
        user: userDetailMap.get(row.userId) ?? null,
        ownerUsername: (row as any).ownerUsername ?? null,
        abnormal: isAbnormal({
          telegramUserId: row.telegramUserId ?? null,
          ownerUsername: (row as any).ownerUsername ?? null,
          userId: row.userId,
          status: row.status,
        }),
        pointsCost: row.pointsCost ?? 0,
        itemName: row.itemName ?? null,
        amount: Number(row.amount),
        status: row.status,
        scene: (row as any).scene ?? null,
        sourceChatId: row.sourceChatId != null ? row.sourceChatId.toString() : null,
        reason: row.reason ?? null,
        usedAt: row.usedAt ? row.usedAt.toISOString() : null,
        usedInstanceId: row.usedInstanceId ?? null,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    }
  })

  // GET /api/admin/bot/bindings —— 绑定记录（TGID ↔ 面板账号）
  app.get('/api/admin/bot/bindings', { ...adminOnly, config: READ_LIMIT }, async (request) => {
    const q = (request.query || {}) as Record<string, string>
    const { page, pageSize, skip, take } = pagination(q)
    const keyword = String(q.keyword || '').trim().slice(0, 80)

    const where: Record<string, unknown> = {}
    if (keyword) {
      where.OR = [
        { telegramUserId: { contains: keyword } },
        { telegramUsername: { contains: keyword, mode: 'insensitive' as const } },
        { firstName: { contains: keyword, mode: 'insensitive' as const } },
        { lastName: { contains: keyword, mode: 'insensitive' as const } },
        {
          user: {
            is: {
              OR: [
                { username: { contains: keyword, mode: 'insensitive' as const } },
                { email: { contains: keyword, mode: 'insensitive' as const } }
              ]
            }
          }
        }
      ]
    }

    const [rows, total] = await Promise.all([
      prisma.prisma.userTelegramBinding.findMany({
        where,
        orderBy: { boundAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { id: true, username: true, email: true, status: true } }
        }
      }),
      prisma.prisma.userTelegramBinding.count({ where })
    ])

    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        telegramUserId: row.telegramUserId,
        telegramUsername: row.telegramUsername,
        firstName: row.firstName,
        lastName: row.lastName,
        boundAt: row.boundAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        user: row.user
          ? {
              id: row.user.id,
              username: row.user.username,
              email: row.user.email,
              status: row.user.status
            }
          : null
      })),
      total,
      page,
      pageSize
    }
  })

  // ==================== 守护日志 ====================
  // GET /api/admin/bot/guard-logs/:id —— 单次巡检的详细报告（成员明细 + 处置清单）
  app.get('/api/admin/bot/guard-logs/:id', { ...adminOnly, config: READ_LIMIT }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '无效的日志 ID'))
    }
    const row = await prisma.prisma.botGuardLog.findUnique({ where: { id } })
    if (!row) return reply.code(404).send(apiError(ErrorCode.INVALID_PARAMS, '日志不存在'))

    // 明细里存的是面板用户 id（机器人只知道 clientId），这里读的时候换成用户名。
    // 读时解析而不是存快照：用户改了用户名，历史日志也能跟着显示新的。
    const rawDetails = ((row as any).details ?? null) as Array<Record<string, any>> | null
    let details = rawDetails
    if (Array.isArray(rawDetails) && rawDetails.length) {
      const ids = Array.from(new Set(rawDetails.map((d) => Number(d?.clientId) || 0).filter((n) => n > 0)))
      const users = ids.length
        ? await prisma.prisma.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, username: true, status: true }
          })
        : []
      const userMap = new Map(users.map((u) => [u.id, u]))
      details = rawDetails.map((d) => {
        const u = userMap.get(Number(d?.clientId) || 0)
        return { ...d, username: u?.username ?? null, userStatus: u?.status ?? null }
      })
    }

    // 处置作业（异步）：按 runId 找那次守护的作业，把进度与结果合并进来。
    // 机器人的 report 是「发起处置后立刻上报」，作业可能还在跑 —— 所以日志里的
    // enforced 常常是空的，真正的清单在这里从 guard_enforce_jobs 取。
    const rowRunId = (row as any).runId ?? null
    const job = rowRunId
      ? await prisma.prisma.guardEnforceJob.findFirst({
          where: { runId: rowRunId },
          orderBy: { id: 'desc' }
        })
      : null

    const enforced =
      (row as any).enforced ??
      (job
        ? {
            userIds: [],
            instances: await (async () => {
              const sus = ((job.suspended ?? []) as any[])
              if (!sus.length) return []
              const uids = Array.from(new Set(sus.map((s) => Number(s?.userId) || 0).filter((n) => n > 0)))
              const us = uids.length
                ? await prisma.prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, username: true } })
                : []
              const nm = new Map(us.map((u) => [u.id, u.username ?? '']))
              return sus.map((s) => ({
                id: Number(s?.instanceId) || 0,
                name: String(s?.name ?? ''),
                username: nm.get(Number(s?.userId) || 0) ?? ''
              }))
            })(),
            unbound: (job.unbound ?? []) as any[],
            dryRun: false
          }
        : null)

    return {
      id: row.id,
      runAt: row.runAt.toISOString(),
      chatId: row.chatId != null ? row.chatId.toString() : null,
      source: row.source,
      total: row.total,
      inGroup: row.inGroup,
      leftGroup: row.leftGroup,
      unbound: row.unbound,
      failed: row.failed,
      durationMs: row.durationMs,
      error: row.error ?? null,
      details,
      enforced,
      enforceJob: job
        ? {
            id: job.id,
            status: job.status,
            totalUsers: job.totalUsers,
            totalInstances: job.totalInstances,
            doneInstances: job.doneInstances,
            incusDeleted: job.incusDeleted,
            incusFailed: job.incusFailed,
            updatedAt: job.updatedAt.toISOString()
          }
        : null
    }
  })

  // POST /api/admin/bot/guard/test —— 守护链路诊断（不执行销毁，只回报「现在跑一次会怎样」）
  app.post('/api/admin/bot/guard/test', { ...adminOnly, config: READ_LIMIT }, async () => {
    const guard = await getGuardSettings()
    const enabled = guard.enabled !== false
    const intervalMinutes = Math.max(1, Number(guard.intervalMinutes || 15))

    const last = await prisma.prisma.botGuardLog.findFirst({ orderBy: { runAt: 'desc' } })
    const lastRunAgoMs = last ? Date.now() - last.runAt.getTime() : null
    // 超过 2 个周期没上报 = 机器人 cron 没在跑
    const stale = lastRunAgoMs == null ? true : lastRunAgoMs > intervalMinutes * 2 * 60 * 1000

    const [boundUsers, instanceCount] = await Promise.all([
      prisma.prisma.userTelegramBinding.count(),
      prisma.prisma.instance.count({ where: { status: { not: 'deleted' } } }),
    ])

    const hints: string[] = []
    if (!enabled) hints.push('守护开关是关闭状态，机器人不会巡检')
    if (!last) hints.push('机器人从未上报过巡检结果：确认机器人已部署且 cron 在跑')
    else if (stale) hints.push(`最近一次巡检在 ${Math.round((lastRunAgoMs || 0) / 60000)} 分钟前，超过 2 个周期（${intervalMinutes * 2} 分钟），机器人可能没在运行`)
    if (last?.error) hints.push(`上次巡检报错：${last.error}`)
    if (last && last.leftGroup > 0) hints.push(`上次巡检发现 ${last.leftGroup} 人不在群，这些人的容器会被销毁`)

    return {
      ok: true,
      guardEnabled: enabled,
      intervalMinutes,
      lastRun: last
        ? {
            runAt: last.runAt.toISOString(),
            source: last.source,
            total: last.total,
            inGroup: last.inGroup,
            leftGroup: last.leftGroup,
            unbound: last.unbound,
            failed: last.failed,
            durationMs: last.durationMs,
            error: last.error ?? null,
          }
        : null,
      lastRunAgoMs,
      stale,
      nextRunDueInMs: lastRunAgoMs == null ? null : Math.max(0, intervalMinutes * 60 * 1000 - lastRunAgoMs),
      boundUsers,
      instanceCount,
      verdict: !enabled ? 'disabled' : !last ? 'never' : stale ? 'stale' : 'ok',
      hints,
    }
  })

  // GET /api/admin/bot/guard-logs?page=1&pageSize=20
  app.get('/api/admin/bot/guard-logs', { ...adminOnly, config: READ_LIMIT }, async (request) => {
    const q = (request.query || {}) as Record<string, string>
    const { page, pageSize, skip, take } = pagination(q)

    const [items, total] = await Promise.all([
      prisma.prisma.botGuardLog.findMany({
        orderBy: { runAt: 'desc' },
        skip,
        take,
      }),
      prisma.prisma.botGuardLog.count(),
    ])

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: items.map((row) => ({
        id: row.id,
        runAt: row.runAt.toISOString(),
        chatId: row.chatId != null ? row.chatId.toString() : null,
        source: row.source,
        total: row.total,
        inGroup: row.inGroup,
        leftGroup: row.leftGroup,
        unbound: row.unbound,
        failed: row.failed,
        durationMs: row.durationMs,
        error: row.error ?? null,
      })),
    }
  })

  // ==================== 清理记录 ====================
  // POST /api/admin/bot/cleanup { promoExpiredDays?, guardLogDays? }
  // 机器人签发的抵扣码与守护日志会持续增长：这里按保留天数清理，并把「删了多少」返回给前端当清理记录。
  // GET /api/admin/bot/promos?status=&keyword=&page=&pageSize=
  // 「折扣」页专用：只列后台生成的公开券（telegram_user_id 为空），支持状态筛选与分页。
  app.get('/api/admin/bot/promos', { ...adminOnly, config: READ_LIMIT }, async (request) => {
    const q = (request.query || {}) as Record<string, string>
    const { page, pageSize, skip, take } = pagination(q)
    const status = String(q.status || '').trim()
    const keyword = String(q.keyword || '').trim()

    const where: Record<string, any> = { telegramUserId: null }
    if (status && status !== 'all') where.status = status
    if (keyword) {
      where.OR = [
        { code: { contains: keyword, mode: 'insensitive' } },
        { itemName: { contains: keyword, mode: 'insensitive' } }
      ]
      // 按使用者用户名搜索：used_instance_id 不是 Prisma 关系字段，无法直接 join username。
      // 先查用户名匹配的用户 → 其名下实例 id，再把 usedInstanceId IN (...) 作为 OR 条件。
      const matchedUsers = await prisma.prisma.user.findMany({
        where: { username: { contains: keyword, mode: 'insensitive' } },
        select: { id: true }
      })
      if (matchedUsers.length) {
        const matchedInstances = await prisma.prisma.instance.findMany({
          where: { userId: { in: matchedUsers.map((u) => u.id) } },
          select: { id: true }
        })
        if (matchedInstances.length) {
          where.OR.push({ usedInstanceId: { in: matchedInstances.map((i) => i.id) } })
        }
      }
      // 按使用者 TGID 搜索：先查绑定表匹配的 TGID → userId → 其名下实例 id → OR
      const matchedBindings = await prisma.prisma.userTelegramBinding.findMany({
        where: { telegramUserId: { contains: keyword } },
        select: { userId: true }
      })
      if (matchedBindings.length) {
        const tgInstances = await prisma.prisma.instance.findMany({
          where: { userId: { in: matchedBindings.map((b) => b.userId) } },
          select: { id: true }
        })
        if (tgInstances.length) {
          where.OR.push({ usedInstanceId: { in: tgInstances.map((i) => i.id) } })
        }
      }
    }

    const [items, total] = await Promise.all([
      prisma.prisma.botPromoCode.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.prisma.botPromoCode.count({ where })
    ])

    // 批量反查核销详情：used_instance_id → 实例（name/user_id）→ 使用者（username）。
    // 一次 findMany 拿实例、再一次拿用户，避免逐行 N+1 查询。
    const usedInstanceIds = Array.from(
      new Set(items.map((r) => r.usedInstanceId).filter((v): v is number => v != null))
    )
    const instanceMap = new Map<number, { name: string; userId: number }>()
    const userMap = new Map<number, { id: number; username: string }>()
    const tgMap = new Map<number, string>()
    if (usedInstanceIds.length) {
      const instances = await prisma.prisma.instance.findMany({
        where: { id: { in: usedInstanceIds } },
        select: { id: true, name: true, userId: true }
      })
      for (const inst of instances) instanceMap.set(inst.id, { name: inst.name, userId: inst.userId })
      const userIds = Array.from(new Set(instances.map((i) => i.userId)))
      if (userIds.length) {
        const users = await prisma.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true }
        })
        for (const u of users) userMap.set(u.id, { id: u.id, username: u.username })
        const bindings = await prisma.prisma.userTelegramBinding.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, telegramUserId: true }
        })
        for (const b of bindings) tgMap.set(b.userId, b.telegramUserId)
      }
    }

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: items.map((row) => {
        const inst = row.usedInstanceId != null ? instanceMap.get(row.usedInstanceId) : undefined
        const owner = inst ? userMap.get(inst.userId) : undefined
        return {
          id: row.id,
          code: row.code,
          itemName: row.itemName ?? null,
          amount: Number(row.amount),
          status: row.status,
          scene: row.scene,
          cycleMonths: row.cycleMonths,
          reason: row.reason ?? null,
          usedAt: row.usedAt ? row.usedAt.toISOString() : null,
          usedInstanceId: row.usedInstanceId ?? null,
          usedInstanceName: inst?.name ?? null,
          usedByUserId: owner?.id ?? null,
          usedByUsername: owner?.username ?? null,
          usedByTelegramId: owner ? (tgMap.get(owner.id) ?? null) : null,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString()
        }
      })
    }
  })

  // PATCH /api/admin/bot/promos/:code —— 修改（金额/商品名/场景/周期/有效期/说明）
  app.patch('/api/admin/bot/promos/:code', { ...adminOnly, config: WRITE_LIMIT }, async (request, reply) => {
    const code = String((request.params as { code: string }).code || '').trim()
    const body = (request.body || {}) as Record<string, any>
    const existing = await prisma.prisma.botPromoCode.findUnique({ where: { code } })
    if (!existing) return reply.code(404).send(apiError(ErrorCode.INVALID_PARAMS, '券码不存在'))
    if (existing.telegramUserId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '该券由机器人签发，只能在「兑换记录」查看'))
    }
    if (existing.status === 'used') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '已核销的券不能修改'))
    }

    const data: Record<string, any> = {}
    if (body.amount !== undefined) {
      const amount = Number(body.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '抵扣金额无效'))
      }
      data.amount = amount.toFixed(2)
    }
    if (body.itemName !== undefined) data.itemName = body.itemName ? String(body.itemName).trim().slice(0, 120) : null
    if (body.scene !== undefined) data.scene = body.scene === 'renew' ? 'renew' : 'purchase'
    if (body.cycleMonths !== undefined) data.cycleMonths = toInt(body.cycleMonths, 1, 1, 120)
    if (body.ttlDays !== undefined) {
      data.expiresAt = new Date(Date.now() + toInt(body.ttlDays, 7, 1, 3650) * 24 * 60 * 60 * 1000)
    }
    if (body.note !== undefined) data.reason = body.note ? String(body.note).trim().slice(0, 200) : null

    if (!Object.keys(data).length) return { ok: true, changed: 0 }
    await prisma.prisma.botPromoCode.update({ where: { code }, data })
    await createLog(request.user!.id, 'bot', 'admin.promo.update', `修改后台券 ${code}`, 'success')
    return { ok: true, changed: Object.keys(data).length }
  })

  // POST /api/admin/bot/promos/:code/void —— 作废（保留记录，核销时会被拒）
  app.post('/api/admin/bot/promos/:code/void', { ...adminOnly, config: WRITE_LIMIT }, async (request, reply) => {
    const code = String((request.params as { code: string }).code || '').trim()
    const existing = await prisma.prisma.botPromoCode.findUnique({ where: { code } })
    if (!existing) return reply.code(404).send(apiError(ErrorCode.INVALID_PARAMS, '券码不存在'))
    if (existing.status === 'used') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '已核销的券不能作废'))
    }
    await prisma.prisma.botPromoCode.update({ where: { code }, data: { status: 'void' } })
    await createLog(request.user!.id, 'bot', 'admin.promo.void', `作废后台券 ${code}`, 'success')
    return { ok: true, status: 'void' }
  })

  // POST /api/admin/bot/promos/:code/restore —— 恢复（作废 → 可用）
  app.post('/api/admin/bot/promos/:code/restore', { ...adminOnly, config: WRITE_LIMIT }, async (request, reply) => {
    const code = String((request.params as { code: string }).code || '').trim()
    const existing = await prisma.prisma.botPromoCode.findUnique({ where: { code } })
    if (!existing) return reply.code(404).send(apiError(ErrorCode.INVALID_PARAMS, '券码不存在'))
    if (existing.status !== 'void') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '只有已作废的券可以恢复'))
    }
    await prisma.prisma.botPromoCode.update({ where: { code }, data: { status: 'active' } })
    await createLog(request.user!.id, 'bot', 'admin.promo.restore', `恢复后台券 ${code}`, 'success')
    return { ok: true, status: 'active' }
  })

  // DELETE /api/admin/bot/promos/:code —— 删除（仅限未核销的后台券）
  app.delete('/api/admin/bot/promos/:code', { ...adminOnly, config: WRITE_LIMIT }, async (request, reply) => {
    const code = String((request.params as { code: string }).code || '').trim()
    const existing = await prisma.prisma.botPromoCode.findUnique({ where: { code } })
    if (!existing) return reply.code(404).send(apiError(ErrorCode.INVALID_PARAMS, '券码不存在'))
    if (existing.telegramUserId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '机器人签发的券不允许删除'))
    }
    if (existing.status === 'used') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '已核销的券不允许删除（请改为作废以保留审计）'))
    }
    await prisma.prisma.botPromoCode.delete({ where: { code } })
    await createLog(request.user!.id, 'bot', 'admin.promo.delete', `删除后台券 ${code}`, 'success')
    return { ok: true }
  })

  // GET /api/admin/bot/catalog
  // 「折扣」页要按「地区 / 套餐」生成券，这里把面板目录吐给前端（结构与机器人 /api/bot/catalog 同构）。
  app.get('/api/admin/bot/catalog', { ...adminOnly, config: READ_LIMIT }, async () => {
    const packages = await prisma.prisma.package.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        plans: { select: { id: true, name: true, cpu: true, memory: true, disk: true, billingCycle: true } }
      }
    })
    const packageIds = packages.map((p) => p.id)
    const binds = packageIds.length
      ? await prisma.prisma.packageHost.findMany({
          where: { packageId: { in: packageIds } },
          include: { host: { select: { id: true, name: true, location: true, countryCode: true } } }
        })
      : []
    const regionsByPackage = new Map<number, Array<{ hostId: number; hostName: string; location: string; countryCode: string | null; country: string | null }>>()
    for (const b of binds) {
      const list = regionsByPackage.get(b.packageId) || []
      const location = String(b.host?.location || '').trim()
      const hostName = String(b.host?.name || '').trim()
      const cc = b.host?.countryCode ?? null
      list.push({
        hostId: b.hostId,
        hostName,
        location: location || hostName || `节点#${b.hostId}`,
        countryCode: cc,
        // 节点设置的国家（下拉里显示这个，而不是带赞助商的 location 自由文本）
        country: countryName(cc)
      })
      regionsByPackage.set(b.packageId, list)
    }
    return {
      packages: packages.map((p) => ({
        id: p.id,
        name: p.name,
        plans: (p.plans || []).map((pl) => ({ id: pl.id, name: pl.name, billingCycle: (pl as any).billingCycle ?? null })),
        regions: regionsByPackage.get(p.id) || []
      }))
    }
  })

  // POST /api/admin/bot/promo
  // 管理员后台生成「公开券」：不绑定任何用户（telegramUserId = null），人人可用。
  // 与机器人发的券共用同一张表、同一套核销链路（/validate-bot-promo + 创建实例/续费），
  // 所以后台券会照常出现在「兑换记录」里，也能被任意用户拿去抵扣。
  app.post('/api/admin/bot/promo', { ...adminOnly, config: WRITE_LIMIT }, async (request, reply) => {
    const body = (request.body || {}) as Record<string, any>
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '抵扣金额无效'))
    }
    const scene = body.scene === 'renew' ? 'renew' : 'purchase'
    // 周期必填：不允许静默按「月」发券（否则季度券会变成月券）
    if (body.cycleMonths === undefined || body.cycleMonths === null || body.cycleMonths === '') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '必须指定券的适用周期（月/季/半年/年）'))
    }
    const cycleMonths = toInt(body.cycleMonths, 0, 0, 120)
    if (![1, 3, 6, 12].includes(cycleMonths)) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '周期只能是 1（月）/ 3（季）/ 6（半年）/ 12（年）'))
    }
    const ttlDays = toInt(body.ttlDays, 7, 1, 3650)
    const count = toInt(body.count, 1, 1, 50)
    const itemName = body.itemName != null ? String(body.itemName).trim().slice(0, 120) : null
    const note = body.note != null ? String(body.note).trim().slice(0, 200) : null

    // 后台券用 DDY 前缀，与机器人签发的 INC 券区分开（一眼能看出券从哪来）
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
    const created: string[] = []

    for (let n = 0; n < count; n++) {
      let code = ''
      for (let attempt = 0; attempt < 10 && !code; attempt++) {
        const bytes = randomBytes(10)
        let candidate = 'DDY'
        for (let i = 0; i < 10; i++) candidate += alphabet[bytes[i]! % alphabet.length]
        const exists = await prisma.prisma.botPromoCode.findUnique({ where: { code: candidate } })
        if (!exists) code = candidate
      }
      if (!code) continue
      const row = await prisma.prisma.botPromoCode.create({
        data: {
          code,
          userId: request.user!.id,   // 创建者（管理员），仅作审计归属
          telegramUserId: null,       // ← 公开券：不绑定任何 TG 用户
          pointsCost: 0,              // 后台生成，不消耗积分
          itemName,
          amount,
          status: 'active',
          reason: note,
          scene,
          cycleMonths,
          expiresAt
        }
      })
      created.push(row.code)
    }

    if (created.length) {
      await createLog(
        request.user!.id,
        'bot',
        'admin.promo.create',
        `后台生成公开抵扣码 ${created.length} 张（场景 ${scene === 'renew' ? '续费' : '新开'}，抵扣 ¥${amount}，${cycleMonths} 个月，${ttlDays} 天有效）：${created.join(', ')}`,
        'success'
      )
    }

    return {
      created,
      count: created.length,
      scene,
      amount,
      cycleMonths,
      expiresAt: expiresAt.toISOString()
    }
  })

  app.post('/api/admin/bot/cleanup', { ...adminOnly, config: CLEANUP_LIMIT }, async (request) => {
    const body = (request.body || {}) as Record<string, any>
    const promoExpiredDays = toInt(body.promoExpiredDays, 90, 1, 3650)
    const guardLogDays = toInt(body.guardLogDays, 90, 1, 3650)

    const promoBefore = new Date(Date.now() - promoExpiredDays * 24 * 60 * 60 * 1000)
    const guardBefore = new Date(Date.now() - guardLogDays * 24 * 60 * 60 * 1000)

    // 只清「已过期或已核销且到期很久」的码：active 且未过期的一律保留，否则会误删用户手里还没用的码。
    const promo = await prisma.prisma.botPromoCode.deleteMany({
      where: {
        createdAt: { lt: promoBefore },
        OR: [
          { status: { in: ['used', 'expired'] } },
          { expiresAt: { lt: promoBefore } },
        ],
      },
    })

    const guard = await prisma.prisma.botGuardLog.deleteMany({
      where: { createdAt: { lt: guardBefore } },
    })

    return {
      cleanedAt: new Date().toISOString(),
      criteria: { promoExpiredDays, guardLogDays },
      removed: { promoCodes: promo.count, guardLogs: guard.count },
    }
  })

  // GET /api/admin/bot/overview —— 三个模块的概览数字，供后台卡片使用。
  app.get('/api/admin/bot/overview', { ...adminOnly, config: READ_LIMIT }, async () => {
    const now = new Date()
    const [totalCodes, activeCodes, usedCodes, expiredCodes, voidCodes, guardLogCount, lastGuardRun, boundUsers] =
      await Promise.all([
        prisma.prisma.botPromoCode.count({ where: { telegramUserId: { not: null } } }),
        prisma.prisma.botPromoCode.count({ where: { telegramUserId: { not: null }, status: 'active', expiresAt: { gte: now } } }),
        prisma.prisma.botPromoCode.count({ where: { telegramUserId: { not: null }, status: 'used' } }),
        prisma.prisma.botPromoCode.count({
          where: { telegramUserId: { not: null }, status: 'active', expiresAt: { lt: now } },
        }),
        // 已作废（void）：既不算可用也不算已核销，之前没归类导致「总数 ≠ 可用+已核销+已过期」
        prisma.prisma.botPromoCode.count({ where: { telegramUserId: { not: null }, status: { in: ['void', 'refunded'] } } }),
        prisma.prisma.botGuardLog.count(),
        prisma.prisma.botGuardLog.findFirst({ orderBy: { runAt: 'desc' } }),
        prisma.prisma.userTelegramBinding.count(),
      ])

    return {
      promo: {
        total: totalCodes,
        active: activeCodes,
        used: usedCodes,
        expired: expiredCodes,
        void: voidCodes,
        totalDiscount: Number(
          (await prisma.prisma.botPromoCode.aggregate({ _sum: { amount: true } }))._sum.amount || 0
        ),
      },
      guard: {
        logCount: guardLogCount,
        lastRunAt: lastGuardRun ? lastGuardRun.runAt.toISOString() : null,
        lastRun: lastGuardRun
          ? {
              inGroup: lastGuardRun.inGroup,
              leftGroup: lastGuardRun.leftGroup,
              unbound: lastGuardRun.unbound,
              failed: lastGuardRun.failed,
              durationMs: lastGuardRun.durationMs,
            }
          : null,
      },
      bindings: boundUsers,
    }
  })

  // ==================== 设置 ====================
  // 机器人桥接共享密钥：存系统配置表（加密落库），后台可随时查看/轮换，即时生效（无需重启）。

  // GET /api/admin/bot/settings
  app.get('/api/admin/bot/settings', { ...adminOnly, config: READ_LIMIT }, async () => {
    const [bridge, guard, tgBind] = await Promise.all([
      getBotBridgeSettings(),
      getGuardSettings(),
      getTgBindSettings()
    ])
    return {
      ...bridge,
      guardEnabled: guard.enabled,
      guardIntervalMinutes: guard.intervalMinutes,
      expiryReminderDays: guard.expiryReminderDays,
      expiryReminderEnabled: guard.expiryReminderEnabled,
      tgBindEnabled: tgBind.enabled,
      tgBindGroupChatId: tgBind.groupChatId,
      tgBindHasToken: Boolean(tgBind.botToken),
      tgBindAvailable: tgBind.available
    }
  })

  // PUT /api/admin/bot/settings
  //   { token?, generate?, guardEnabled?, guardIntervalMinutes?, tgBindEnabled?, tgBindBotToken?, tgBindGroupChatId? }
  app.put('/api/admin/bot/settings', { ...adminOnly, config: WRITE_LIMIT }, async (request, reply) => {
    const body = (request.body || {}) as Record<string, any>
    const wantsToken = body.generate === true || String(body.token || '').trim() !== ''
    const wantsGuard =
      body.guardEnabled !== undefined ||
      body.guardIntervalMinutes !== undefined ||
      body.expiryReminderDays !== undefined ||
      body.expiryReminderEnabled !== undefined
    const wantsTgBind = body.tgBindEnabled !== undefined
      || body.tgBindBotToken !== undefined
      || body.tgBindGroupChatId !== undefined

    if (!wantsToken && !wantsGuard && !wantsTgBind) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '请提供 token / generate=true，或守护 / TGID 绑定设置'))
    }

    if (wantsToken) {
      const generate = body.generate === true
      const token = generate ? generateBotBridgeToken() : String(body.token || '').trim()
      if (!token) {
        return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '请提供 token，或传 generate=true 自动生成'))
      }
      if (token.length < 16 || token.length > 200) {
        return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, 'token 长度需在 16-200 之间'))
      }
      await setBotBridgeToken(token)
    }

    if (wantsGuard) {
      await setGuardSettings({
        enabled: body.guardEnabled !== undefined ? body.guardEnabled === true : undefined,
        intervalMinutes: body.guardIntervalMinutes !== undefined ? Number(body.guardIntervalMinutes) : undefined,
        expiryReminderDays: body.expiryReminderDays !== undefined ? Number(body.expiryReminderDays) : undefined,
        expiryReminderEnabled:
          body.expiryReminderEnabled !== undefined ? body.expiryReminderEnabled === true : undefined
      })
    }

    if (wantsTgBind) {
      await setTgBindSettings({
        enabled: body.tgBindEnabled !== undefined ? body.tgBindEnabled === true : undefined,
        // 空字符串表示「清空」，null/undefined 表示「不改」
        botToken: body.tgBindBotToken !== undefined ? String(body.tgBindBotToken) : undefined,
        groupChatId: body.tgBindGroupChatId !== undefined ? String(body.tgBindGroupChatId) : undefined
      })
    }

    try {
      await createLog(
        request.user.id,
        'system',
        'bot_bridge.update',
        `更新机器人桥接设置（${[
          wantsToken ? '密钥' : '',
          wantsGuard ? '守护' : '',
          wantsTgBind ? 'TGID绑定' : ''
        ].filter(Boolean).join('+')}）`,
        'success'
      )
    } catch (logError) {
      console.error('[BotBridge] 写审计日志失败:', logError)
    }

    const [bridge, guard, tgBind] = await Promise.all([
      getBotBridgeSettings(),
      getGuardSettings(),
      getTgBindSettings()
    ])
    return {
      ok: true,
      ...bridge,
      guardEnabled: guard.enabled,
      guardIntervalMinutes: guard.intervalMinutes,
      expiryReminderDays: guard.expiryReminderDays,
      expiryReminderEnabled: guard.expiryReminderEnabled,
      tgBindEnabled: tgBind.enabled,
      tgBindGroupChatId: tgBind.groupChatId,
      tgBindHasToken: Boolean(tgBind.botToken),
      tgBindAvailable: tgBind.available
    }
  })

  // DELETE /api/admin/bot/settings —— 清空密钥（关闭机器人桥接）
  app.delete('/api/admin/bot/settings', { ...adminOnly, config: WRITE_LIMIT }, async (request) => {
    await setBotBridgeToken('')

    try {
      await createLog(
        request.user.id,
        'system',
        'bot_bridge.disable',
        '关闭机器人桥接（清空密钥）',
        'success'
      )
    } catch (logError) {
      console.error('[BotBridge] 写审计日志失败:', logError)
    }

    const [bridge, guard, tgBind] = await Promise.all([
      getBotBridgeSettings(),
      getGuardSettings(),
      getTgBindSettings()
    ])
    return {
      ok: true,
      ...bridge,
      guardEnabled: guard.enabled,
      guardIntervalMinutes: guard.intervalMinutes,
      expiryReminderDays: guard.expiryReminderDays,
      expiryReminderEnabled: guard.expiryReminderEnabled,
      tgBindEnabled: tgBind.enabled,
      tgBindGroupChatId: tgBind.groupChatId,
      tgBindHasToken: Boolean(tgBind.botToken),
      tgBindAvailable: tgBind.available
    }
  })
}
