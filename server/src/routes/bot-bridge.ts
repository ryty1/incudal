/**
 * 机器人桥接路由（Bot Bridge）
 *
 * 让外部机器人（tg-antispam）以共享密钥方式读取面板数据、下发提醒，功能对齐魔方财务那套集成。
 *
 * 设计取舍（相对魔方插件的简化）：
 *  - **不提供 ack 回执**：魔方需要面板记"已通知"，是因为回执状态存在面板侧；
 *    这里的机器人自身有持久化，按 `sinceId` / `instanceId+expiresAt` 水位去重即可不重发。
 *    砍掉 ack = 面板侧零状态、少两个端点、不会出现"回执丢了就再不提醒"的死锁。
 *  - **鉴权**：见 plugins/bot-bridge-auth.ts。持 token 者等同面板管理员（与魔方插件同信任级）。
 *  - **只读为主**：读接口任意调用；写接口（promo / redeem）单独限流，且必须校验资源归属。
 */

import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import * as prisma from '../db/index.js'
import { calculateRenewBilling, performRenewal } from '../db/billing-operations.js'
import { apiError, ErrorCode } from '../lib/errors.js'
import { getGuardSettings, getTgBindSettings } from '../lib/bot-bridge-config.js'
import { selectAvailableHost } from '../db/hosts.js'

const READ_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } }
const WRITE_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } }

const PROMO_CODE_PREFIX = 'INC'

// 节点国家代码 → 本地化国家名（与管理员 catalog 同一套标准）
const countryDisplay = (() => {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }) } catch { return null }
})()
function countryName(code: string | null | undefined): string | null {
  const c = String(code || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return null
  try { return countryDisplay?.of(c) ?? null } catch { return null }
}


/** 生成 10 位大写字母+数字随机码（去掉 0/O/1/I 等易混淆字符）。 */
function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(10)
  let out = ''
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
}

/** 到期查询的天数上限：调用方传再大也压到这里，防止一次性拖全表。 */
// 与面板「到期提前提醒」的可填范围（0~90 天）保持一致。
// 原来这里是 30，导致管理员填 60/90 时被静默夹到 30 —— 设置看起来生效其实没生效。
const EXPIRY_MAX_DAYS = 90
const LIST_MAX_LIMIT = 200

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 实例 → 面向机器人的精简视图（只吐通知真正需要的字段，不带 rootPassword 之类敏感项）。 */
function toInstanceView(row: any) {
  return {
    instanceId: row.id,
    name: row.name,
    userId: row.userId,
    hostId: row.hostId ?? null,
    // 套餐 id：机器人「续期券」用它校验「绑定账号里有没有对应套餐的设备」
    packageId: row.packageId ?? null,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    ipv4: row.ipv4 ?? null,
    ipv6: row.ipv6 ?? null,
    sshPort: row.sshPort ?? null,
    billingCycle: row.billingCycle ?? null,
    billingPrice: row.billingPrice != null ? Number(row.billingPrice) : null,
    autoRenew: row.autoRenew === true,
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
    suspendReason: row.suspendReason ?? null,
  }
}

/**
 * 给实例补上「国家名 + 套餐名」。
 * 机器人「设备」列表的按钮要显示成 `国家 · 套餐`（如 `日本 · 东京 - 软银`），
 * 面板这边才有这两份数据（instances.package_id → packages.name；
 * instances.host_id → hosts.country_code），所以在这里批量补上，避免机器人逐台回查。
 */
async function enrichInstancesWithLabels<T extends { instanceId: number; packageId?: number | null; hostId?: number | null }>(
  views: T[]
): Promise<Array<T & { packageName: string | null; countryName: string | null }>> {
  if (!views.length) return views as any
  const pkgIds = Array.from(new Set(views.map((v) => Number(v.packageId) || 0).filter((n) => n > 0)))
  const hostIds = Array.from(new Set(views.map((v) => Number(v.hostId) || 0).filter((n) => n > 0)))
  const [pkgs, hosts] = await Promise.all([
    pkgIds.length
      ? prisma.prisma.package.findMany({ where: { id: { in: pkgIds } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: number; name: string }>),
    hostIds.length
      ? prisma.prisma.host.findMany({ where: { id: { in: hostIds } }, select: { id: true, countryCode: true } })
      : Promise.resolve([] as Array<{ id: number; countryCode: string }>)
  ])
  const pkgMap = new Map(pkgs.map((p) => [p.id, p.name ?? null]))
  const hostMap = new Map(hosts.map((h) => [h.id, countryName(h.countryCode)]))
  return views.map((v) => ({
    ...v,
    packageName: pkgMap.get(Number(v.packageId) || 0) ?? null,
    countryName: hostMap.get(Number(v.hostId) || 0) ?? null
  })) as any
}

/**
 * 给实例补上「公网接入信息」。
 * 面板里的实例只有内网 IP（10.10.x.x），公网 IP 在宿主机上（hosts.nat_public_ip），
 * SSH 公网端口在 port_mappings（private_port=22 → public_port）。机器人展示要给公网的。
 */
async function enrichInstancesWithPublicNetwork<T extends { instanceId: number; hostId?: number | null }>(
  views: T[]
): Promise<
  Array<
    T & {
      publicIp: string | null
      publicSshPort: number | null
      /** 全部端口映射（机器人「设备详情」要列出来；SSH 那条由机器人自己按 22 过滤掉） */
      portMappings: Array<{ publicPort: number; privatePort: number; protocol: string }>
    }
  >
> {
  if (!views.length) return views as any
  const ids = views.map((v) => Number(v.instanceId)).filter((n) => n > 0)
  const hostIds = Array.from(new Set(views.map((v) => Number(v.hostId) || 0).filter((n) => n > 0)))
  const [hosts, mappings] = await Promise.all([
    hostIds.length
      ? prisma.prisma.host.findMany({
          where: { id: { in: hostIds } },
          select: { id: true, natPublicIp: true, natPublicIpv6: true }
        })
      : Promise.resolve([] as Array<{ id: number; natPublicIp: string | null; natPublicIpv6: string | null }>),
    ids.length
      ? prisma.prisma.portMapping.findMany({
          where: { instanceId: { in: ids } },
          select: { instanceId: true, publicPort: true, privatePort: true, protocol: true }
        })
      : Promise.resolve([] as Array<{ instanceId: number; publicPort: number; privatePort: number; protocol: string }>)
  ])
  const hostMap = new Map(hosts.map((h) => [Number(h.id), h.natPublicIp ?? null]))
  const hostV6Map = new Map(hosts.map((h) => [Number(h.id), h.natPublicIpv6 ?? null]))
  const sshMap = new Map<number, number>()
  // 全量映射按实例分组（上面那次 findMany 本来就把所有映射都查回来了，
  // 原来只拿去算 SSH 端口、其余丢掉；现在一并返回给机器人用）
  const portsMap = new Map<number, Array<{ publicPort: number; privatePort: number; protocol: string }>>()
  for (const m of mappings) {
    const id = Number(m.instanceId)
    const list = portsMap.get(id) ?? []
    list.push({
      publicPort: Number(m.publicPort),
      privatePort: Number(m.privatePort),
      protocol: String(m.protocol || 'tcp')
    })
    portsMap.set(id, list)
    if (Number(m.privatePort) === 22 && String(m.protocol || 'tcp').toLowerCase() === 'tcp') {
      sshMap.set(id, Number(m.publicPort))
    }
  }
  return views.map((v) => ({
    ...v,
    publicIp: (hostMap.get(Number(v.hostId) || 0) ?? null) as string | null,
    publicIpv6: (hostV6Map.get(Number(v.hostId) || 0) ?? null) as string | null,
    publicSshPort: sshMap.get(Number(v.instanceId)) ?? null,
    portMappings: (portsMap.get(Number(v.instanceId)) ?? []).sort((a, b) => a.publicPort - b.publicPort)
  })) as any
}

export default async function botBridgeRoutes(fastify: FastifyInstance) {
  const botGuard = { preHandler: fastify.authenticateBot }

  // ==================== 到期提醒 ====================
  // GET /api/bot/expiry?days=5&limit=100
  // 返回「N 天内到期且尚未封停」的实例，并带上该用户的 Telegram 绑定（没有绑定的也返回，由调用方决定是否跳过）。
  fastify.get('/expiry', { ...botGuard, config: READ_LIMIT }, async (request) => {
    const q = request.query as Record<string, string>
    const days = toInt(q.days, 5, 1, EXPIRY_MAX_DAYS)
    const limit = toInt(q.limit, 100, 1, LIST_MAX_LIMIT)
    const now = new Date()
    const deadline = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

    const rows = await prisma.prisma.instance.findMany({
      where: {
        expiresAt: { not: null, lte: deadline, gte: now },
        status: { not: 'deleted' as any },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: {
        id: true, name: true, userId: true, status: true, expiresAt: true,
        ipv4: true, ipv6: true, sshPort: true, billingCycle: true,
        billingPrice: true, autoRenew: true, suspendedAt: true, suspendReason: true,
      },
    })

    if (!rows.length) return { items: [], checkedAt: now.toISOString(), days }

    const userIds = Array.from(new Set(rows.map((r) => r.userId)))
    const bindings = await prisma.prisma.userTelegramBinding.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, telegramUserId: true, telegramUsername: true, firstName: true, lastName: true },
    })
    const bindMap = new Map(bindings.map((b) => [b.userId, b]))

    return {
      checkedAt: now.toISOString(),
      days,
      items: rows.map((row) => {
        const bind = bindMap.get(row.userId)
        return {
          ...toInstanceView(row),
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          telegram: bind
            ? {
                userId: bind.telegramUserId,
                username: bind.telegramUsername ?? null,
                firstName: bind.firstName ?? null,
                lastName: bind.lastName ?? null,
              }
            : null,
          hasTelegramBinding: !!bind,
        }
      }),
    }
  })

  // ==================== 续费事件（水位拉取） ====================
  // GET /api/bot/renewals?sinceId=0&limit=50&type=renew
  // 面板不记回执：调用方记住 lastId 即可保证不重发。
  // type 可选（newPurchase / renew / upgrade / downgrade / refund / transfer_fee），不传取全部。
  fastify.get('/renewals', { ...botGuard, config: READ_LIMIT }, async (request, _reply: FastifyReply) => {
    const q = request.query as Record<string, string>
    const sinceId = toInt(q.sinceId, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = toInt(q.limit, 50, 1, LIST_MAX_LIMIT)
    const recordType = String(q.type || '').trim()

    const rows = await prisma.prisma.instanceBillingRecord.findMany({
      where: {
        id: { gt: sinceId },
        ...(recordType ? { type: recordType as any } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
    })

    if (!rows.length) return { items: [], nextSinceId: sinceId }

    const userIds = Array.from(new Set(rows.map((r) => r.userId)))
    const bindings = await prisma.prisma.userTelegramBinding.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, telegramUserId: true, telegramUsername: true, firstName: true, lastName: true },
    })
    const bindMap = new Map(bindings.map((b) => [b.userId, b]))

    const lastId = rows[rows.length - 1]!.id
    return {
      nextSinceId: lastId,
      items: rows.map((row: any) => ({
        recordId: row.id,
        userId: row.userId,
        instanceId: row.instanceId ?? null,
        type: row.type ?? null,
        amount: row.amount != null ? Number(row.amount) : null,
        months: row.months ?? null,
        periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
        remark: row.remark ?? null,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        telegram: bindMap.has(row.userId)
          ? {
              userId: bindMap.get(row.userId)!.telegramUserId,
              username: bindMap.get(row.userId)!.telegramUsername ?? null,
              firstName: bindMap.get(row.userId)!.firstName ?? null,
            }
          : null,
      })),
    }
  })

  // ==================== 实例查询 ====================
  /**
   * 节点离线时，其上的实例对机器人显示为「离线」（offline）。
   * 与用户端 /api/instances 的派生规则保持一致：不写数据库，节点恢复后自动还原。
   */
  const deriveBotInstanceStatus = (status: string, hostStatus?: string | null): string => {
    // 与用户端 /api/instances 的派生规则保持一致：不写数据库，节点恢复后自动还原。
    // 节点离线 → offline；节点异常 → abnormal（机器人侧再映射成「离线」/「异常」）
    if (status === 'running' || status === 'stopped') {
      if (hostStatus === 'offline') return 'offline'
      if (hostStatus === 'abnormal') return 'abnormal'
    }
    return status
  }

  fastify.get('/users/:userId/instances', { ...botGuard, config: READ_LIMIT }, async (request, reply: FastifyReply) => {
    const userId = toInt((request.params as any).userId, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!userId) return reply.code(400).send(apiError(ErrorCode.INVALID_ID))

    const rows = await prisma.prisma.instance.findMany({
      // 必须排除已删除的实例：否则容器删掉了，机器人设备列表里还留着（幽灵设备）
      where: { userId, status: { not: 'deleted' } },
      orderBy: { expiresAt: 'asc' },
      take: LIST_MAX_LIMIT,
      include: { host: { select: { status: true } } },
    })
    const views = await enrichInstancesWithPublicNetwork(
      rows.map((row: any) => {
        const view = toInstanceView(row)
        view.status = deriveBotInstanceStatus(String(view.status || ''), row?.host?.status)
        return view
      })
    )
    return { items: await enrichInstancesWithLabels(views), total: rows.length }
  })

  fastify.get('/instances/:id', { ...botGuard, config: READ_LIMIT }, async (request, reply) => {
    const id = toInt((request.params as any).id, 0, 1, Number.MAX_SAFE_INTEGER)
    if (!id) return reply.code(400).send(apiError(ErrorCode.INVALID_ID))
    // 已删除的实例对机器人视同不存在（避免幽灵设备还能点开详情）
    const row = await prisma.prisma.instance.findFirst({
      where: { id, status: { not: 'deleted' } },
      include: { host: { select: { status: true } } },
    })
    if (!row) return reply.code(404).send(apiError(ErrorCode.INSTANCE_NOT_FOUND))
    const view = toInstanceView(row)
    view.status = deriveBotInstanceStatus(String(view.status || ''), (row as any)?.host?.status)
    const [enriched] = await enrichInstancesWithPublicNetwork([view])
    const [labeled] = await enrichInstancesWithLabels([enriched])
    return { instance: labeled }
  })

  // ==================== 用户账单/兑换记录 ====================
  fastify.get('/users/:userId/records', { ...botGuard, config: READ_LIMIT }, async (request, reply: FastifyReply) => {
    const userId = toInt((request.params as any).userId, 0, 1, Number.MAX_SAFE_INTEGER)
    const limit = toInt((request.query as any)?.limit, 50, 1, LIST_MAX_LIMIT)
    if (!userId) return reply.code(400).send(apiError(ErrorCode.INVALID_ID))

    const rows = await prisma.prisma.instanceBillingRecord.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: limit,
    })
    return {
      clientId: userId,
      items: rows.map((row: any) => ({
        recordId: row.id,
        instanceId: row.instanceId ?? null,
        amount: row.amount != null ? Number(row.amount) : null,
        type: row.type ?? null,
        remark: row.remark ?? null,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      })),
      total: rows.length,
    }
  })

  // ==================== 套餐目录（对应魔方 meta） ====================
  fastify.get('/catalog', { ...botGuard, config: READ_LIMIT }, async () => {
    // Package 用 active（不是 enabled）、无 sortOrder；PackagePlan 才有 isActive/sortOrder。
    const packages = await prisma.prisma.package.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      take: 200,
      include: {
        plans: {
          where: { isActive: true, isSoldOut: false },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    // 顺带查出「套餐 → 可用节点地区」，供机器人拼商品名（地区 + 套餐）。
    // 绑定关系在 package_hosts 表里，地区取 hosts.location，缺省回落 countryCode。
    const packageIds = packages.map((p: any) => p.id)
    const bindings = packageIds.length
      ? await prisma.prisma.packageHost.findMany({
        where: { packageId: { in: packageIds } },
        include: { host: { select: { id: true, name: true, location: true, countryCode: true } } },
      })
      : []
    const regionsByPackage = new Map<number, Array<{ hostId: number; hostName: string; location: string; countryCode: string | null; country: string | null }>>()
    for (const b of bindings as any[]) {
      const list = regionsByPackage.get(b.packageId) || []
      const hostName = String(b.host?.name || '').trim()
      const location = String(b.host?.location || '').trim()
        || String(b.host?.countryCode || '').trim()
        || hostName
        || `节点#${b.hostId}`
      if (!list.some((x) => x.hostId === b.hostId)) {
        const cc = b.host?.countryCode ?? null
        list.push({ hostId: b.hostId, hostName, location, countryCode: cc, country: countryName(cc) })
      }
      regionsByPackage.set(b.packageId, list)
    }

    return {
      configured: true,
      packages: packages.map((p: any) => ({
        id: p.id,
        name: p.name,
        // 该套餐可落地的节点地区（机器人用它做「地区 + 套餐」下拉）
        regions: regionsByPackage.get(p.id) || [],
        plans: (p.plans || []).map((plan: any) => ({
          id: plan.id,
          name: plan.name,
          price: plan.price != null ? Number(plan.price) : null,
          billingCycle: plan.billingCycle ?? 1,
          setupFee: plan.setupFee != null ? Number(plan.setupFee) : null,
          cpu: plan.cpu ?? null,
          memory: plan.memory ?? null,
          disk: plan.disk ?? null,
        })),
      })),
    }
  })

  // ==================== TG 绑定关系（对应魔方 guard_meta） ====================
  fastify.get('/guard/meta', { ...botGuard, config: READ_LIMIT }, async (request) => {
    const q = request.query as Record<string, string>
    const limit = toInt(q.limit, 500, 1, 2000)

    const bindings = await prisma.prisma.userTelegramBinding.findMany({
      orderBy: { boundAt: 'desc' },
      take: limit,
    })
    // 开关与周期由**面板后台**决定（管理员可改），不再由机器人的请求参数决定。
    // 机器人只读这里的结果，自己不做判断。
    const guard = await getGuardSettings()
    // 巡检目标群：用「TGID 绑定」里配的群（管理员在 TG管理 → 设置 里填的那个）
    const tgBind = await getTgBindSettings().catch(() => null)
    const groupId = String(tgBind?.groupChatId || '').trim()
    return {
      enabled: guard.enabled,
      intervalValue: guard.intervalMinutes,
      intervalUnit: 'minute',
      // 实例到期提醒（管理员在 TG管理 → 设置 → 到期提醒 里配；独立开关）
      expiryReminderDays: guard.expiryReminderDays,
      expiryReminderEnabled: guard.expiryReminderEnabled,
      groupId,
      /**
       * TGID 绑定模块是否可用（= 开关开启 + Bot Token 已填 + 校验用群 Chat ID 已填，三项齐备）。
       * 节点离线/上线通知只看这一项，与守护开关无关。
       */
      tgBindAvailable: Boolean(tgBind?.available),
      bindings: bindings.map((b) => ({
        tgUserId: b.telegramUserId,
        tgUsername: b.telegramUsername ?? null,
        clientId: b.userId,
        boundAt: b.boundAt.toISOString(),
      })),
    }
  })

  // GET /api/bot/hosts/events?sinceId=0&limit=50
  // 节点「离线 / 恢复在线」事件（由 status-scheduler 写入 logs 表）。
  // 机器人拉到后推到守护群；机器人自己记录 lastId 做增量拉取。
  // 文案按「国家 · 套餐」组织（不暴露节点名）。
  fastify.get('/hosts/events', { ...botGuard, config: READ_LIMIT }, async (request) => {
    const q = request.query as Record<string, string>
    const sinceId = toInt(q.sinceId, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = toInt(q.limit, 50, 1, 200)

    const rows = await prisma.prisma.log.findMany({
      where: {
        module: 'system',
        action: { in: ['host.status_offline', 'host.status_online', 'host.status_abnormal'] },
        id: { gt: sinceId },
      },
      orderBy: { id: 'asc' },
      take: limit,
    })

    // 从日志内容里解析节点名（格式：节点离线：<name>（<location>））
    const parseHostName = (content: string): string => {
      const m = String(content || '').match(/：([^（(]+)/)
      return m ? m[1].trim() : ''
    }
    const names = Array.from(new Set(rows.map((r: any) => parseHostName(r.content)).filter(Boolean)))
    const hosts: Array<{ id: number; name: string; countryCode: string | null; location: string | null }> = names.length
      ? await prisma.prisma.host.findMany({
          where: { name: { in: names } },
          select: { id: true, name: true, countryCode: true, location: true },
        })
      : []
    const hostByName = new Map(hosts.map((h: any) => [h.name, h]))

    // 每个节点上的实例套餐 → 「国家 · 套餐」（去重）
    const hostIds = hosts.map((h: any) => h.id)
    const insts = hostIds.length
      ? await prisma.prisma.instance.findMany({
          where: { hostId: { in: hostIds }, status: { not: 'deleted' } },
          select: { hostId: true, packageId: true },
        })
      : []
    const pkgIds = Array.from(new Set(insts.map((i: any) => Number(i.packageId) || 0).filter((n: number) => n > 0)))
    const pkgs = pkgIds.length
      ? await prisma.prisma.package.findMany({ where: { id: { in: pkgIds } }, select: { id: true, name: true } })
      : []
    const pkgNameById = new Map<number, string | null>(pkgs.map((p: any) => [p.id, p.name ?? null]))
    const labelsByHost = new Map<number, string[]>()
    for (const inst of insts) {
      const host = hosts.find((h: any) => h.id === inst.hostId)
      const country = host ? countryName(host.countryCode) : null
      const pkg = pkgNameById.get(Number(inst.packageId) || 0) || null
      if (!pkg) continue
      // 套餐名格式不统一：有的自带国家（「新加坡AWS」），有的没有（「东京AWS - 小叮当赞助」）。
      // 自带国家就不重复加前缀。
      const label = country && !pkg.includes(country) ? `${country} · ${pkg}` : pkg
      const arr = labelsByHost.get(inst.hostId) || []
      if (!arr.includes(label)) arr.push(label)
      labelsByHost.set(inst.hostId, arr)
    }

    return {
      items: rows.map((r: any) => {
        const name = parseHostName(r.content)
        const host = hostByName.get(name)
        const labels = host ? labelsByHost.get(host.id) || [] : []
        return {
          id: r.id,
          action: r.action,
          online: r.action === 'host.status_online',
          /** 异常：TCP 通但 Incus API 不响应（区别于 offline） */
          abnormal: r.action === 'host.status_abnormal',
          /** 节点名（放最前面：同名套餐靠它区分） */
          hostName: name,
          /** 节点位置（面板 hosts.location） */
          location: host?.location ?? null,
          /** 「国家 · 套餐」列表；最多 20 条 */
          labels: labels.slice(0, 20),
          labelTotal: labels.length,
          createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        }
      }),
      lastId: rows.length ? rows[rows.length - 1].id : sinceId,
    }
  })

  // GET /api/bot/bindings/:tgUserId
  // 查某个 Telegram 用户在面板上有没有绑定账号（机器人「检测绑定」用）。
  // 一个 TGID 在面板里最多只能绑一个账号（DB 层 telegram_user_id 唯一约束保证）。
  fastify.get<{ Params: { tgUserId: string } }>('/bindings/:tgUserId', { ...botGuard, config: READ_LIMIT }, async (request) => {
    const tgUserId = String(request.params.tgUserId || '').trim()
    if (!tgUserId) return { bound: false, binding: null }

    const binding = await prisma.prisma.userTelegramBinding.findUnique({
      where: { telegramUserId: tgUserId }
    })
    if (!binding) return { bound: false, binding: null }

    return {
      bound: true,
      binding: {
        tgUserId: binding.telegramUserId,
        tgUsername: binding.telegramUsername,
        clientId: binding.userId,
        boundAt: binding.boundAt.toISOString()
      }
    }
  })

  // GET /api/bot/capacity?packageId=&planId=
  // 新开（purchase）商品兑换前查「面板还有没有容量」：有容量才允许兑换，没有就拒。
  // 用的是面板自己的 selectAvailableHost，口径与真实下单完全一致。
  fastify.get<{ Querystring: { packageId?: string; planId?: string; userId?: string } }>('/capacity', { ...botGuard, config: READ_LIMIT }, async (request, reply) => {
    const packageId = toInt(request.query.packageId, 0, 0, Number.MAX_SAFE_INTEGER)
    if (!packageId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '缺少 packageId'))
    }
    // 传了 userId 就一并校验「每账号实例数配额」——与面板创建实例时的校验保持一致，
    // 否则会出现「机器人兑券成功、面板却因配额不足开不了机」的错配。
    const quotaUserId = toInt(request.query.userId, 0, 0, Number.MAX_SAFE_INTEGER)
    const planId = toInt(request.query.planId, 0, 0, Number.MAX_SAFE_INTEGER)
    const plan = planId
      ? await prisma.prisma.packagePlan.findUnique({ where: { id: planId } })
      : null

    // 方案下架 / 售罄：与面板判定一致（packages.ts 里 availablePlans = isActive && !isSoldOut）
    // 之前不查这两项，导致「方案已下架/售罄，机器人还能兑换」。
    if (plan) {
      if (!plan.isActive) {
        return { available: false, reason: '该方案已下架', planInactive: true, cpu: Number(plan.cpu ?? 15), memory: Number(plan.memory ?? 128), disk: Number(plan.disk ?? 512) }
      }
      if (plan.isSoldOut) {
        return { available: false, reason: '该方案已售罄', planSoldOut: true, cpu: Number(plan.cpu ?? 15), memory: Number(plan.memory ?? 128), disk: Number(plan.disk ?? 512) }
      }
    }

    const binds = await prisma.prisma.packageHost.findMany({
      where: { packageId },
      select: { hostId: true }
    })
    const packageHostIds = binds.map((b) => b.hostId)

    const cpu = Number((plan as any)?.cpu ?? 15)
    const memory = Number((plan as any)?.memory ?? 128)
    const disk = Number((plan as any)?.disk ?? 512)

    // 该套餐的节点是否还有在线的：离线(offline)/异常(abnormal)的节点开不了机，
    // 直接拦掉，避免发出「面板用不了」的券（用户端创建页也已隐藏这类套餐）。
    if (packageHostIds.length > 0) {
      const onlineHostCount = await prisma.prisma.host.count({
        // 流量超限被锁流(limited)的节点也开不了机，一并排除
        where: { id: { in: packageHostIds }, status: 'online', trafficBlocked: false } as any
      })
      if (onlineHostCount === 0) {
        return {
          available: false,
          reason: '该套餐所在节点当前离线或异常，暂时无法开通，请等节点恢复后再试',
          hostUnavailable: true,
          cpu,
          memory,
          disk
        }
      }
    }

    // 先查账号级实例数配额（不通过就直接返回，不必再查节点容量）
    if (quotaUserId) {
      const pkg = await prisma.prisma.package.findUnique({
        where: { id: packageId },
        select: { userId: true, globalShared: true, globalMaxInstances: true }
      })
      if (pkg && pkg.globalShared && pkg.userId !== quotaUserId) {
        const maxInst = Number(pkg.globalMaxInstances)
        if (Number.isFinite(maxInst) && maxInst > 0) {
          const used = await prisma.prisma.instance.count({
            where: { packageId, userId: quotaUserId, status: { not: 'deleted' } }
          })
          if (used >= maxInst) {
            return {
              available: false,
              reason: `该套餐每个账号最多 ${maxInst} 台，你已开通 ${used} 台`,
              quotaExceeded: true,
              maxInstances: maxInst,
              usedInstances: used,
              cpu, memory, disk
            }
          }
        }
      }
    }

    let host: any = null
    try {
      host = await selectAvailableHost({ packageHostIds, cpu, memory, disk })
    } catch (err) {
      console.error('[BotBridge] capacity 查询失败:', err)
      return { available: false, reason: '容量查询失败', cpu, memory, disk }
    }


      // ── 还能开几台：只统计【在线且未被流量锁流】的节点 ──
      // 口径与 selectAvailableHost 完全一致：
      //   剩余CPU   = cpuAllowanceMax - max(实例实时求和, hosts.cpuUsed)
      //   剩余内存  = memoryMax      - max(实例实时求和, hosts.memoryUsed)
      //   单节点可开 = min(剩余CPU / 套餐CPU, 剩余内存 / 套餐内存)   ← 按最小的算
      //   只舍不入（Math.floor）；磁盘/端口不再限制
      let slots = 0
      let slotBottleneck: string | null = null
      const slotHosts: Array<{ hostId: number; name: string; slots: number; bottleneck: string }> = []
      try {
        const candidates = await prisma.prisma.host.findMany({
          where: {
            ...(packageHostIds.length > 0 ? { id: { in: packageHostIds } } : {}),
            status: 'online',
            trafficBlocked: false,
          } as any,
          select: {
            id: true,
            name: true,
            cpuAllowanceMax: true,
            memoryMax: true,
            cpuUsed: true,
            memoryUsed: true,
            instances: {
              where: { status: { not: 'deleted' } },
              select: { cpu: true, memory: true },
            },
          },
        })

        for (const h of candidates as any[]) {
          const cpuAllow = Number(h.cpuAllowanceMax ?? 0)
          const memMax = Number(h.memoryMax ?? 0)
          // 未配置配额的节点开不了机（与 selectAvailableHost 一致）
          if (!(cpuAllow > 0) || !(memMax > 0)) continue

          const instCpu = (h.instances || []).reduce((sum: number, i: any) => sum + Number(i.cpu || 0), 0)
          const instMem = (h.instances || []).reduce((sum: number, i: any) => sum + Number(i.memory || 0), 0)
          const cpuUsedEff = Math.max(instCpu, Number(h.cpuUsed ?? 0))
          const memUsedEff = Math.max(instMem, Number(h.memoryUsed ?? 0))

          const cpuLeft = Math.max(0, cpuAllow - cpuUsedEff)
          const memLeft = Math.max(0, memMax - memUsedEff)

          // 只舍不入：套餐 CPU/内存为 0 时视为不受限（避免除零）
          const byCpu = cpu > 0 ? Math.floor(cpuLeft / cpu) : Number.POSITIVE_INFINITY
          const byMem = memory > 0 ? Math.floor(memLeft / memory) : Number.POSITIVE_INFINITY
          const n = Number.isFinite(Math.min(byCpu, byMem)) ? Math.max(0, Math.floor(Math.min(byCpu, byMem))) : 0
          const bottleneck = byCpu <= byMem ? 'cpu' : 'memory'
          if (n > 0) {
            slots += n
            slotHosts.push({ hostId: Number(h.id), name: h.name, slots: n, bottleneck })
          } else if (!slotBottleneck) {
            slotBottleneck = bottleneck
          }
        }
      } catch (err) {
        console.error('[BotBridge] slots 计算失败:', err)
      }

    return {
      available: Boolean(host),
      reason: host ? '' : '面板当前没有可用容量',
      hostId: host ? Number(host.id) : null,
      cpu,
      memory,
      disk,
        // 新增：按「在线且未锁流」节点的最小瓶颈算，还能开几台（只舍不入）
        slots,
        slotBottleneck,
        slotHosts,
    }
  })

  // ==================== 抵扣码（对应魔方 create_promo / promo_status / renew_redeem） ====================
  // 语义：机器人在群里扣掉用户积分后签发此码，用户拿它抵扣续费。
  // **不修改既有计费逻辑**：先按码面额给余额充值、再调用面板原生 performRenewal，
  // 让扣款、延长到期、记账单全部仍走面板自己那套（带乐观锁）的事务，避免两套账逻辑分叉。
  // 净效果 = 码面额覆盖的部分不花钱，超出部分从余额扣，多出的留作余额。

  // POST /api/bot/promo
  fastify.post('/promo', { ...botGuard, config: WRITE_LIMIT }, async (request, reply) => {
    const body = (request.body || {}) as Record<string, any>
    const userId = toInt(body.userId, 0, 1, Number.MAX_SAFE_INTEGER)
    const amount = Number(body.amount)
    // 券有效期：机器人只发 ttlMinutes（如 10 分钟）。
    // ttlDays 保留兼容老机器人；两者都传时以 ttlMinutes 为准。
    const hasTtlMinutes = body.ttlMinutes !== undefined && body.ttlMinutes !== null && body.ttlMinutes !== ''
    const ttlMinutesRaw = hasTtlMinutes ? toInt(body.ttlMinutes, 0, 1, 90 * 24 * 60) : 0
    const ttlDays = hasTtlMinutes
      ? Math.max(1, Math.ceil(ttlMinutesRaw / (24 * 60)))   // 仅兼容/日志，不决定过期
      : toInt(body.ttlDays, 7, 1, 90)
    // 实际过期时间：按分钟精确计算（ttlMinutes 优先，否则按天）
    const ttlDaysFallback = ttlDays   // 兼容：未传 ttlMinutes 时按天
    const expiresAtMs = hasTtlMinutes
      ? Date.now() + ttlMinutesRaw * 60 * 1000
      : Date.now() + ttlDaysFallback * 24 * 60 * 60 * 1000
    const sourceChatId = body.sourceChatId != null ? BigInt(Math.floor(Number(body.sourceChatId))) : null
    const reason = String(body.reason || '').trim().slice(0, 200) || null
    // 场景：purchase=创建实例用，renew=续费用。两者互不通用，由机器人显式指定。
    const scene = String(body.scene || '').trim().toLowerCase() === 'renew' ? 'renew' : 'purchase'
    // 优惠券对应周期（月）：只认 1/3/6/12，其它值一律按月处理
    // 周期必填：不允许静默按「月」发券
    if (body.cycleMonths === undefined || body.cycleMonths === null || body.cycleMonths === '') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '必须指定券的适用周期（1/3/6/12 个月）'))
    }
    const rawCycle = toInt(body.cycleMonths, 0, 0, 12)
    if (![1, 3, 6, 12].includes(rawCycle)) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '周期只能是 1（月）/ 3（季）/ 6（半年）/ 12（年）'))
    }
    const cycleMonths = rawCycle
    // 券绑定的「套餐 + 节点」：核销时与实例精确比对。
    // 机器人发券时按「用户该套餐下、节点在线的实例」选定后传进来；不传则为 null（老行为，跳过校验）。
    const bindPackageId = toInt(body.packageId, 0, 1, Number.MAX_SAFE_INTEGER)
    const bindHostId = toInt(body.hostId, 0, 1, Number.MAX_SAFE_INTEGER)

    if (!userId) return reply.code(400).send(apiError(ErrorCode.INVALID_ID))
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '抵扣金额无效'))
    }

    const user = await prisma.prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send(apiError(ErrorCode.USER_NOT_FOUND))

    // 必须已绑定 Telegram：未绑定账号的 TGID 不允许兑券。
    // （券要同时绑定 TGID 和用户名，没绑定就无从校验归属，也不能核销）
    const tgBinding = await prisma.prisma.userTelegramBinding.findUnique({
      where: { userId },
      select: { telegramUserId: true }
    })
    if (!tgBinding || !tgBinding.telegramUserId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '该账号尚未绑定 Telegram，请先在面板「个人资料」完成 TGID 绑定后再兑换'))
    }
    // 机器人若显式带了 tgUserId，必须与绑定一致（防止拿别人的 TGID 兑券）
    const reqTg = String(body.tgUserId ?? '').trim()
    if (reqTg && reqTg !== String(tgBinding.telegramUserId)) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, 'TGID 与账号绑定不一致，无法兑换'))
    }

    // 续期券：发券时就拦截——不允许把券发出去等到核销才发现用不了。
    // ① 必须带上「套餐 + 节点」（机器人发券前已按用户设备选定）
    // ② 该节点必须在线（离线 offline / 异常 abnormal 都拦）
    // ③ 该账号在该节点上必须确实有该套餐的设备
    if (scene === 'renew') {
      if (!bindPackageId || !bindHostId) {
        return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS,
          '续期券必须指定套餐与节点，请更新机器人后重试'))
      }
      const bindHostRow = await prisma.prisma.host.findUnique({
        where: { id: bindHostId },
        select: { name: true, status: true }
      })
      if (!bindHostRow || bindHostRow.status !== 'online') {
        const st = bindHostRow?.status
        const stText = st === 'abnormal' ? '异常' : st === 'maintenance' ? '维护中' : '离线'
        return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
          `节点${bindHostRow?.name ? `「${bindHostRow.name}」` : ''}当前${stText}，无法发放续期券，请等节点恢复后再试`))
      }
      const usableCount = await prisma.prisma.instance.count({
        where: {
          userId,
          hostId: bindHostId,
          status: { not: 'deleted' },
          packagePlan: { packageId: bindPackageId }
        }
      })
      if (usableCount === 0) {
        return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
          '该账号在该节点的该套餐下没有设备，无法发放续期券'))
      }
    }

    // 创建实例券（purchase）：同样在发券时确认该套餐还有在线节点，避免发出用不了的券。
    if (scene === 'purchase' && bindPackageId) {
      const pkgHosts = await prisma.prisma.packageHost.findMany({
        where: { packageId: bindPackageId },
        select: { hostId: true }
      })
      const pkgHostIds = pkgHosts.map((x: { hostId: number }) => x.hostId)
      if (pkgHostIds.length > 0) {
        const onlineCount = await prisma.prisma.host.count({
          where: { id: { in: pkgHostIds }, status: 'online' }
        })
        if (onlineCount === 0) {
          return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
            '该套餐所在节点当前离线或异常，无法发放抵扣券，请等节点恢复后再试'))
        }
      }
    }

    // 券码唯一：撞码概率极低，但仍查库重试，保证不重复
    let code = ''
    for (let attempt = 0; attempt < 8 && !code; attempt++) {
      const candidate = `${PROMO_CODE_PREFIX}${randomCode()}`
      const exists = await prisma.prisma.botPromoCode.findUnique({
        where: { code: candidate },
        select: { id: true }
      })
      if (!exists) code = candidate
    }
    // 极端兜底（连撞 8 次）：退化成带时间戳的码，仍然唯一
    if (!code) code = `${PROMO_CODE_PREFIX}${Date.now().toString(36).toUpperCase()}`
    const record = await prisma.prisma.botPromoCode.create({
      data: {
        code,
        userId,
        amount: amount.toFixed(2),
        status: 'active',
        scene,
        cycleMonths,
        sourceChatId,
        reason,
        // 以下三项只为后台「兑换记录」展示：面板本身没有积分概念，由机器人把扣了多少积分报进来。
        telegramUserId: body.telegramUserId != null ? String(body.telegramUserId).trim().slice(0, 64) : null,
        // 归属快照：核销时与 TGID 一并比对。用户名不可修改，比邮箱更可靠（邮箱可改）。
        ownerEmail: user.email ? String(user.email).trim() : null,
        ownerUsername: user.username ? String(user.username).trim() : null,
        pointsCost: toInt(body.pointsCost, 0, 0, 1_000_000),
        itemName: body.itemName != null ? String(body.itemName).trim().slice(0, 120) : null,
        packageId: bindPackageId || null,
        hostId: bindHostId || null,
        expiresAt: new Date(expiresAtMs),
      },
    })

    return {
      exchangeNo: String(record.id),
      promoCode: record.code,
      amount: Number(record.amount),
      pointsCost: record.pointsCost,
      redeemStatus: record.status,
      scene: record.scene,
      cycleMonths: record.cycleMonths,
      expiresAt: record.expiresAt.toISOString(),
    }
  })

  // POST /api/bot/guard/enforce —— 守护处置（**异步作业**）
  //
  // 做什么：把「不在群」用户名下的实例标记 deleted，并真删宿主机上的 Incus 容器；
  //        全部处理干净之后，才自动解绑他的 TG 绑定。
  //
  // 为什么改成异步：面板串行删容器，几十台很容易超过机器人 15 秒的 HTTP 超时。
  // 超时会让机器人以为失败、日志里看不到清理清单，而面板其实还在跑 —— 状态不一致。
  // 现在立即返回「已受理 + 待处理清单」，后台跑完把结果写进 guard_enforce_jobs；
  // 后台「守护日志」详情页按 runId 把作业结果合并进来展示（见 admin-bot-bridge.ts）。
  //
  // 解绑的前置条件：**只有「没有任何一台删除失败」才解绑**。
  // 有失败的保留绑定，下一轮守护会再次命中他，继续把没删完的清掉 —— 不会出现
  // 「解绑了但容器还在宿主机上、而且以后永远不会再被清理」的孤儿。
  fastify.post('/guard/enforce', { ...botGuard, config: WRITE_LIMIT }, async (request, reply) => {
    const body = (request.body || {}) as Record<string, any>
    const runId = String(body.runId || '').trim().slice(0, 64)
    const userIds = Array.isArray(body.userIds)
      ? Array.from(
          new Set(
            body.userIds
              .map((v: any) => Math.floor(Number(v) || 0))
              .filter((n: number) => n > 0)
          )
        ).slice(0, 20)
      : []
    if (!userIds.length) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '缺少 userIds'))
    }
    const dryRun = body.dryRun === true

    const rows = await prisma.prisma.instance.findMany({
      where: {
        userId: { in: userIds },
        status: { notIn: ['deleted', 'suspended'] as any }
      },
      select: { id: true, name: true, userId: true, status: true, expiresAt: true, hostId: true, incusId: true }
    })

    if (dryRun) {
      return {
        dryRun: true,
        count: rows.length,
        wouldSuspend: rows.map((r) => ({ instanceId: r.id, name: r.name, userId: r.userId, status: r.status }))
      }
    }

    // 建作业记录并立即返回，真正的删除在后台跑
    const job = await prisma.prisma.guardEnforceJob.create({
      data: {
        runId: runId || `manual-${Date.now()}`,
        status: 'running',
        totalUsers: userIds.length,
        totalInstances: rows.length,
        suspended: rows.map((r) => ({ instanceId: r.id, name: r.name, userId: r.userId })) as any
      }
    })

    void runGuardEnforceJob(
      job.id,
      rows.map((r) => ({ id: r.id, name: r.name, userId: r.userId, hostId: r.hostId, incusId: r.incusId })),
      userIds
    ).catch((err) => {
      console.error('[BotBridge] 守护作业异常:', err instanceof Error ? err.message : String(err))
    })

    return {
      accepted: true,
      jobId: job.id,
      runId: job.runId,
      status: 'running',
      count: rows.length,
      pending: rows.map((r) => ({ instanceId: r.id, name: r.name, userId: r.userId }))
    }
  })

  /**
   * 后台执行守护处置。逐台：标记 deleted → 真删 Incus 容器 → 刷进度。
   * 全部干净后才解绑；有失败就保留绑定，交给下一轮守护重试。
   */
  async function runGuardEnforceJob(
    jobId: number,
    rows: Array<{ id: number; name: string; userId: number; hostId: number | null; incusId: string | null }>,
    userIds: number[]
  ): Promise<void> {
    const suspended: Array<{ instanceId: number; name: string; userId: number }> = []
    const failed: Array<{ instanceId: number; error: string }> = []
    const incusFailed: Array<{ instanceId: number; error: string }> = []
    let incusDeleted = 0

    for (const row of rows) {
      try {
        // 标记 deleted：宿主机的 CPU/内存/磁盘占用按 status != 'deleted' 汇总，
        // 这一步就把资源还给宿主机（按既有语义忽略退款/分账）。
        await prisma.prisma.instance.update({
          where: { id: row.id },
          data: {
            status: 'deleted' as any,
            suspendedAt: new Date(),
            suspendedBy: 0,
            suspendReason: '不在 Telegram 群组（守护自动销毁）'
          }
        })
        suspended.push({ instanceId: row.id, name: row.name, userId: row.userId })
      } catch (err) {
        failed.push({ instanceId: row.id, error: err instanceof Error ? err.message : String(err) })
        continue
      }

      // 真删容器：只标记 deleted 的话容器还占着宿主机资源，跑久了堆一堆孤儿。
      try {
        if (row.hostId && row.incusId) {
          const host = await prisma.prisma.host.findUnique({ where: { id: row.hostId } })
          if (host) {
            const { getIncusClient, deleteInstance } = await import('../lib/incus/index.js')
            const client = await getIncusClient(host)
            await deleteInstance(client, row.incusId)
            incusDeleted++
          }
        }
      } catch (incusErr) {
        const msg = incusErr instanceof Error ? incusErr.message : String(incusErr)
        incusFailed.push({ instanceId: row.id, error: msg })
        console.warn(`[BotBridge] 守护真删容器失败 instance=${row.id} incusId=${row.incusId}: ${msg}`)
      }

      // 刷进度，前端能看到「处理中 x/y」
      await prisma.prisma.guardEnforceJob
        .update({
          where: { id: jobId },
          data: {
            doneInstances: suspended.length + failed.length,
            incusDeleted,
            incusFailed: incusFailed.length,
            suspended: suspended as any,
            failed: failed as any,
            updatedAt: new Date()
          }
        })
        .catch(() => { /* 进度刷新失败不影响主流程 */ })
    }

    // 解绑：只有全部处理干净才做（见上方注释的孤儿容器问题）
    const clean = incusFailed.length === 0 && failed.length === 0
    const unbound: Array<{ userId: number; telegramUserId: string; username: string | null }> = []
    if (clean) {
      try {
        const bindings = await prisma.prisma.userTelegramBinding.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, telegramUserId: true }
        })
        if (bindings.length) {
          const users = await prisma.prisma.user.findMany({
            where: { id: { in: bindings.map((b) => b.userId) } },
            select: { id: true, username: true }
          })
          const nameMap = new Map(users.map((u) => [u.id, u.username ?? null]))
          await prisma.prisma.userTelegramBinding.deleteMany({ where: { userId: { in: userIds } } })
          await prisma.prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { tgBindChangedAt: new Date() } as any
          })
          for (const b of bindings) {
            unbound.push({ userId: b.userId, telegramUserId: b.telegramUserId, username: nameMap.get(b.userId) ?? null })
          }
        }
      } catch (err) {
        console.warn('[BotBridge] 守护自动解绑失败:', err instanceof Error ? err.message : String(err))
      }
    } else {
      console.warn(
        `[BotBridge] 守护作业 ${jobId} 有 ${incusFailed.length + failed.length} 台未处理干净，保留 TG 绑定等下一轮重试`
      )
    }

    const status = suspended.length === 0 && failed.length > 0 ? 'failed' : !clean ? 'partial' : 'completed'
    await prisma.prisma.guardEnforceJob
      .update({
        where: { id: jobId },
        data: {
          status,
          incusDeleted,
          incusFailed: incusFailed.length,
          doneInstances: suspended.length + failed.length,
          suspended: suspended as any,
          unbound: unbound as any,
          failed: failed as any,
          updatedAt: new Date()
        }
      })
      .catch(() => {})
    console.log(
      `[BotBridge] 守护作业完成: job=${jobId} status=${status} destroyed=${suspended.length} incusDeleted=${incusDeleted} incusFailed=${incusFailed.length} failed=${failed.length} unbound=${unbound.length}`
    )
  }

  // GET /api/bot/promo/list?userId=&scene=&status=&limit=
  // 按面板用户列出他的抵扣码（机器人「券码」页用；面板侧本来就存着这些码）
  fastify.get('/promo/list', { ...botGuard, config: READ_LIMIT }, async (request, reply) => {
    const q = (request.query || {}) as Record<string, string>
    const userId = toInt(q.userId, 0, 0, Number.MAX_SAFE_INTEGER)
    if (!userId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '缺少 userId'))
    }
    const where: Record<string, unknown> = { userId }
    const scene = String(q.scene || '').trim()
    if (scene === 'purchase' || scene === 'renew') where.scene = scene
    const status = String(q.status || '').trim()
    if (status) where.status = status

    const rows = await prisma.prisma.botPromoCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: toInt(q.limit, 100, 1, 200)
    })

    return {
      items: rows.map((row) => ({
        code: row.code,
        itemName: row.itemName,
        amount: Number(row.amount || 0),
        pointsCost: Number(row.pointsCost || 0),
        scene: row.scene ?? null,
        cycleMonths: row.cycleMonths ?? null,
        status: row.status,
        telegramUserId: row.telegramUserId ?? null,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        redeemedAt: row.usedAt ? row.usedAt.toISOString() : null
      }))
    }
  })

  // GET /api/bot/promo/status?codes=a,b,c
  fastify.get('/promo/status', { ...botGuard, config: READ_LIMIT }, async (request, reply) => {
    const q = request.query as Record<string, string>
    const codes = String(q.codes || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 50)
    if (!codes.length) return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '缺少 codes 参数'))

    const rows: any[] = (await prisma.prisma.botPromoCode.findMany({
      where: { code: { in: codes } },
      select: { code: true, userId: true, amount: true, status: true, expiresAt: true, usedAt: true, scene: true, cycleMonths: true, packageId: true, hostId: true, itemName: true, telegramUserId: true, usedInstanceId: true },
    })) as any[]
    const now = new Date()
    const map = new Map(rows.map((r) => [r.code, r]))
    // 券绑定的节点状态（机器人核销前要校验「该节点在线」）
    const bindHostIds = Array.from(new Set(rows.map((r) => Number((r as any).hostId || 0)).filter((n) => n > 0)))
    const hostRows = bindHostIds.length
      ? await prisma.prisma.host.findMany({ where: { id: { in: bindHostIds } }, select: { id: true, status: true, trafficBlocked: true } as any })
      : []
    const hostMap = new Map((hostRows as any[]).map((h) => [Number(h.id), h]))
    return {
      items: codes.map((code) => {
        const row = map.get(code)
        if (!row) return { promoCode: code, status: 'not_found' }
        const expired = row.expiresAt < now
        return {
          promoCode: row.code,
          userId: row.userId,
          amount: Number(row.amount),
          status: expired && row.status === 'active' ? 'expired' : row.status,
          expiresAt: row.expiresAt.toISOString(),
          usedAt: row.usedAt ? row.usedAt.toISOString() : null,
          // 绑定要素：机器人核销前本地预检用（套餐 / 节点 / 周期 / 场景）
          scene: (row as any).scene ?? null,
          cycleMonths: (row as any).cycleMonths ?? null,
          packageId: (row as any).packageId ?? null,
          hostId: (row as any).hostId ?? null,
          itemName: (row as any).itemName ?? null,
          telegramUserId: (row as any).telegramUserId ?? null,
          usedInstanceId: (row as any).usedInstanceId ?? null,
          hostStatus: (() => {
            const h = hostMap.get(Number((row as any).hostId || 0)) as any
            if (!h) return null
            if (h.trafficBlocked) return 'limited'
            return String(h.status || '')
          })(),
        }
      }),
    }
  })

  // POST /api/bot/renew/redeem  { code, instanceId, months? }
  fastify.post('/renew/redeem', { ...botGuard, config: WRITE_LIMIT }, async (request, reply) => {
    const body = (request.body || {}) as Record<string, any>
    const code = String(body.code || '').trim()
    const instanceId = toInt(body.instanceId, 0, 1, Number.MAX_SAFE_INTEGER)
    // 周期必传：不允许「不传周期」的核销（否则无法校验券的周期是否被正确使用）
    if (body.months === undefined || body.months === null || body.months === '') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '必须指定本次核销的周期（1/3/6/12 个月）'))
    }
    const months = toInt(body.months, 0, 0, 24)
    if (![1, 3, 6, 12].includes(months)) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '周期只能是 1（月）/ 3（季）/ 6（半年）/ 12（年）'))
    }
    // 发起核销的 Telegram 用户 id（机器人必须带，用于校验码的 TGID 绑定）
    const tgUserId = String(body.tgUserId || '').trim()

    if (!code || !instanceId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '缺少 code 或 instanceId'))
    }

    const promo = await prisma.prisma.botPromoCode.findUnique({ where: { code } })
    if (!promo) return reply.code(404).send(apiError(ErrorCode.NOT_FOUND, '抵扣码不存在'))
    const now = new Date()
    if (promo.status !== 'active') return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS, '抵扣码已使用或已作废'))
    if (promo.expiresAt < now) return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS, '抵扣码已过期'))
    // 场景隔离：续费只能核销 renew 场景的码，创建实例的码拿到这里来用会被拒。
    if (promo.scene !== 'renew') {
      return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS, '这是「创建实例」专用的抵扣码，不能在续费时使用'))
    }
    // 周期一致性：券上写了周期（cycleMonths）就要求本次续费周期完全一致。
    // months 缺省（0）时按券的周期执行，不拦（兼容老机器人版本）。
    const couponCycle = Number((promo as any).cycleMonths || 0)
    if (couponCycle > 0 && months > 0 && couponCycle !== months) {
      return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
        `这张券限「${couponCycle} 个月」周期使用，本次续费 ${months} 个月，周期不一致，无法核销`))
    }
    // TGID 绑定校验：码是发给某个 TG 用户的，只有那个用户能核销。
    // 机器人必须带 tgUserId；码里没记 TGID 的老码跳过校验，保持兼容。
    if (promo.telegramUserId && !tgUserId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '缺少 tgUserId，无法校验抵扣码归属'))
    }
    if (promo.telegramUserId && tgUserId && promo.telegramUserId !== tgUserId) {
      return reply.code(403).send(apiError(ErrorCode.FORBIDDEN, '这张抵扣码不是发给你的，无法核销'))
    }

    const instance = await prisma.prisma.instance.findUnique({ where: { id: instanceId } })
    if (!instance) return reply.code(404).send(apiError(ErrorCode.INSTANCE_NOT_FOUND))
    // 归属校验：码只能用在码主自己的实例上，防止跨用户套用。
    if (instance.userId !== promo.userId) {
      return reply.code(403).send(apiError(ErrorCode.FORBIDDEN, '该抵扣码不属于此实例的用户'))
    }
    if (!instance.packagePlanId) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '免费实例无需续费'))
    }

    // 实例所属套餐 id（精确比对用）
    const planRow = await prisma.prisma.packagePlan.findUnique({
      where: { id: instance.packagePlanId },
      select: { packageId: true }
    })
    const instancePackageId = planRow?.packageId ?? null

    const bindPkgId = Number((promo as any).packageId || 0)
    const bindHostId = Number((promo as any).hostId || 0)

    // ① 套餐对上：券绑定了套餐时，实例所属套餐必须一致（精确 id，替代原来的名字模糊匹配）
    if (bindPkgId > 0 && instancePackageId !== bindPkgId) {
      return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
        '该券仅限指定套餐的设备使用，当前实例不属于该套餐'))
    }

    // ② 节点对上：券绑定了节点时，实例必须在该节点上，且该节点必须在线
    if (bindHostId > 0) {
      if (Number(instance.hostId) !== bindHostId) {
        return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
          '该券仅限指定节点的设备使用，当前实例不在该节点上'))
      }
      const bindHostRow = await prisma.prisma.host.findUnique({
        where: { id: bindHostId },
        select: { name: true, status: true }
      })
      if (!bindHostRow || bindHostRow.status !== 'online') {
        const st = bindHostRow?.status
        const stText = st === 'abnormal' ? '异常' : st === 'maintenance' ? '维护中' : '离线'
        return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
          `该券指定节点${bindHostRow?.name ? `「${bindHostRow.name}」` : ''}当前${stText}，暂时无法续期，请等节点恢复后再试`))
      }
    }

    // 兜底：老券（没有 packageId/hostId）仍按商品名做宽松匹配，保持向后兼容。
    const promoItem = bindPkgId > 0 ? '' : String((promo as any).itemName || '').trim()
    if (promoItem) {
      const pkgRow = instancePackageId
        ? await prisma.prisma.package.findUnique({ where: { id: instancePackageId }, select: { name: true } })
        : null
      const pkgName = String(pkgRow?.name || '').trim()
      if (pkgName) {
        const segs = promoItem.split('·').map((x: string) => x.trim()).filter(Boolean)
        const match = segs.includes(pkgName) || promoItem === pkgName || promoItem.includes(pkgName)
        if (!match) {
          return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
            `该券仅限「${promoItem}」使用，不能用于「${pkgName}」`))
        }
      }
    }

    // 传进来的 months 只用于一致性校验；实际续费周期以券上的周期为准（见下方 promoCycle）
    let cycleMonths = months > 0 ? months : Math.max(1, instance.billingCycle || 1)

    // 周期校验：券上指定的周期必须与本次续费周期一致
    // （「季度券」只能续一个季度，不能拿来续半年/年）
    const promoCycle = Number((promo as any).cycleMonths || 0)
    if (promoCycle > 0 && promoCycle !== months) {
      return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
        `该券仅限 ${promoCycle} 个月周期使用，本次续费为 ${cycleMonths} 个月`))
    }

    // 实例自身周期也必须与券一致：季付实例只能核季券，月付实例只能核月券
    if (promoCycle > 0) {
      const instCycle = Math.max(1, Number((instance as any).billingCycle || 1))
      if (instCycle !== promoCycle) {
        return reply.code(409).send(apiError(ErrorCode.INVALID_PARAMS,
          `该券限 ${promoCycle} 个月周期使用，但实例当前是 ${instCycle} 个月周期，周期不一致，无法核销`))
      }
    }
    // 券上写了周期 → 实际续费周期一律按券走（校验已保证一致，这里兜住 months=0 的情况）
    if (promoCycle > 0) cycleMonths = promoCycle
    const cost = Number(calculateRenewBilling(instance, cycleMonths).amount)
    const discount = Math.max(0, Math.min(Number(promo.amount), cost))

    try {
      // 直接把码面额作为「本次续费的抵扣」传给 performRenewal：
      // 它在 AFF 折后价上继续抵，并按抵扣后的金额记账单。
      // 这样扣费记录显示的是抵扣后金额（¥0 + 「积分抵扣 -¥1000」），
      // 而不是「先充 1000 再原价扣 1000」——那会留下一条 ¥1000 的续费账单。
      const renewal = await performRenewal(promo.userId, instance, cycleMonths, discount)

      await prisma.prisma.botPromoCode.update({
        where: { id: promo.id },
        data: {
          status: 'used',
          usedAt: new Date(),
          usedInstanceId: instanceId,
        },
      })

      return {
        ok: true,
        promoCode: code,
        discountAmount: discount,
        renewalAmount: renewal.amount,
        newExpiresAt: renewal.newExpiresAt.toISOString(),
        months: cycleMonths,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 现在不再预先入账（抵扣直接作用在本次续费上），performRenewal 是事务，
      // 失败时余额/到期时间自动回滚，无需再手工冲账。
      const status = /余额不足/.test(message) ? 409 : 400
      return reply.code(status).send(apiError(ErrorCode.INVALID_PARAMS, `续费失败: ${message}`))
    }
  })

  // ==================== 守护同步上报（对应魔方 recordGuardSyncRun） ====================
  /** 巡检明细：只保留白名单字段，限制条数与字符串长度，防止机器人塞爆库 */
  const sanitizeGuardDetails = (input: unknown): any => {
    if (!Array.isArray(input)) return null
    const rows = input.slice(0, 2000).map((r: any) => ({
      clientId: Number(r?.clientId) || 0,
      tgUserId: String(r?.tgUserId ?? '').slice(0, 32),
      tgUsername: String(r?.tgUsername ?? '').slice(0, 64),
      tgNickname: String(r?.tgNickname ?? '').slice(0, 128),
      member: r?.member === true,
      statusText: String(r?.statusText ?? '').slice(0, 24),
      message: String(r?.message ?? '').slice(0, 200),
    }))
    return rows.length ? rows : null
  }

  /** 守护处置清单：{ userIds, instances: [{ id, name, username }] } */
  const sanitizeGuardEnforced = (input: unknown): any => {
    if (!input || typeof input !== 'object') return null
    const src = input as any
    const instances = Array.isArray(src.instances)
      ? src.instances.slice(0, 2000).map((i: any) => ({
          id: Number(i?.id) || 0,
          name: String(i?.name ?? '').slice(0, 128),
          username: String(i?.username ?? '').slice(0, 64),
        }))
      : []
    const userIds = Array.isArray(src.userIds)
      ? src.userIds.slice(0, 2000).map((v: any) => Number(v) || 0).filter(Boolean)
      : []
    const unbound = Array.isArray(src.unbound)
      ? src.unbound.slice(0, 2000).map((u: any) => ({
          userId: Number(u?.userId) || 0,
          telegramUserId: String(u?.telegramUserId ?? '').slice(0, 32),
          username: String(u?.username ?? '').slice(0, 64),
        }))
      : []
    if (!instances.length && !userIds.length && !unbound.length) return null
    return { userIds, instances, unbound, dryRun: src.dryRun === true }
  }

  // POST /api/bot/guard/report
  // 机器人每次把群成员在群状态同步完，把统计数字报回来，后台「守护日志」据此排查
  // 「客户明明在群里却被判不在」这类问题。只存统计与错误摘要，不存成员明细。
  fastify.post('/guard/report', { ...botGuard, config: WRITE_LIMIT }, async (request) => {
    const body = (request.body || {}) as Record<string, any>
    await prisma.prisma.botGuardLog.create({
      data: {
        chatId: body.chatId != null ? BigInt(Math.floor(Number(body.chatId))) : null,
        source: String(body.source || 'bot').trim().slice(0, 20) || 'bot',
        total: toInt(body.total, 0, 0, 1_000_000),
        inGroup: toInt(body.inGroup, 0, 0, 1_000_000),
        leftGroup: toInt(body.leftGroup, 0, 0, 1_000_000),
        unbound: toInt(body.unbound, 0, 0, 1_000_000),
        failed: toInt(body.failed, 0, 0, 1_000_000),
        durationMs: toInt(body.durationMs, 0, 0, 86_400_000),
        error: String(body.error || '').trim().slice(0, 500) || null,
        runId: String(body.runId || '').trim().slice(0, 64) || null,
        details: sanitizeGuardDetails(body.details),
        enforced: sanitizeGuardEnforced(body.enforced),
      },
    })
    return { ok: true }
  })
}
