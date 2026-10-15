/**
 * Telegram 专用机器人路由
 * 负责账号绑定、Webhook 管理和私有群入群申请。
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as db from '../db/index.js'
import { prisma } from '../db/prisma.js'

// TG 解绑/换绑冷却：用户自助一个月只能一次；中途要解绑只能找管理员在后台处理
const TG_BIND_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000

/** 返回剩余冷却天数（0 = 可以操作） */
async function tgBindCooldownRemainDays(userId: number): Promise<number> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { tgBindChangedAt: true }
  })
  const last = u?.tgBindChangedAt ? new Date(u.tgBindChangedAt).getTime() : 0
  if (!last) return 0
  const elapsed = Date.now() - last
  if (elapsed >= TG_BIND_COOLDOWN_MS) return 0
  return Math.ceil((TG_BIND_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000))
}

/** 记录一次解绑/换绑（开始冷却计时） */
async function markTgBindChanged(userId: number): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { tgBindChangedAt: new Date() } })
}
import { createLog } from '../db/logs.js'
import { getTgBindSettings } from '../lib/bot-bridge-config.js'

interface TelegramWebhookUser {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

interface TelegramWebhookUpdate {
  message?: {
    chat?: {
      id: number
      type?: string
    }
    from?: TelegramWebhookUser
    text?: string
  }
}

interface TelegramBotConfig {
  enabled: boolean
  configured: boolean
  botUsername: string | null
  botToken: string | null
  webhookSecret: string | null
  group: TelegramGroupConfig
  vipGroup: TelegramGroupConfig
}

type TelegramGroupJoinMode = 'any' | 'all'
type TelegramGroupJoinTarget = 'normal' | 'vip'

interface TelegramGroupConfig {
  enabled: boolean
  configured: boolean
  chatId: string | null
  joinMode: TelegramGroupJoinMode
  minRecharge: number
  minConsume: number
  inviteExpireMinutes: number
}

/** 群标题缓存（chatId → title） */
const chatTitleCache = new Map<string, string>()

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

interface TelegramWebhookInfo {
  url: string
  has_custom_certificate?: boolean
  pending_update_count?: number
  last_error_date?: number
  last_error_message?: string
  max_connections?: number
  allowed_updates?: string[]
}

interface TelegramAdminBindingsQuery {
  page?: string
  pageSize?: string
  search?: string
}

interface TelegramAdminBindingParams {
  id: string
}

interface TelegramInviteLinkResult {
  invite_link: string
}

interface TelegramChatMember {
  status: string
  // getChatMember 会带上成员信息，用于取全名（校验入群时一并保存）
  user?: {
    id: number
    is_bot?: boolean
    first_name?: string
    last_name?: string
    username?: string
  }
}

interface TelegramBotCommand {
  command: string
  description: string
}

const bindTokenPrefix = 'bind_'
const bindTokenTtlMs = 10 * 60 * 1000
const telegramWebhookSecretPattern = /^[A-Za-z0-9_-]{1,256}$/
const telegramBotCommands: TelegramBotCommand[] = [
  { command: 'start', description: '绑定站内账号或查看使用说明' },
  { command: 'join', description: '申请加入普通用户群' },
  { command: 'join_vip', description: '申请加入高级用户群' }
]
const telegramGroupCommandAliases = ['join', 'group', 'apply_group']
const telegramGroupCommands = new Set(telegramGroupCommandAliases.map(command => `/${command}`))
const telegramVipGroupCommands = new Set(['/join_vip'])

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function secureEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) {
    return false
  }
  return timingSafeEqual(aBuffer, bBuffer)
}

function normalizeBotUsername(value: string | null): string | null {
  const username = value?.trim().replace(/^@/, '')
  return username || null
}

function isValidTelegramWebhookSecret(value: string): boolean {
  return telegramWebhookSecretPattern.test(value)
}

function parseNonNegativeAmount(value: string | null, fallback = 0): number {
  const amount = Number.parseFloat(value || '')
  if (!Number.isFinite(amount) || amount < 0) {
    return fallback
  }
  return Math.round(amount * 100) / 100
}

function parseInviteExpireMinutes(value: string | null): number {
  const minutes = Number.parseInt(value || '', 10)
  if (!Number.isFinite(minutes)) {
    return 30
  }
  return Math.min(Math.max(minutes, 1), 10080)
}

function normalizeGroupJoinMode(value: string | null): TelegramGroupJoinMode {
  return value === 'all' ? 'all' : 'any'
}

function buildTelegramGroupConfig(
  enabled: boolean,
  chatIdValue: string | null,
  joinModeValue: string | null,
  minRechargeValue: string | null,
  minConsumeValue: string | null,
  inviteExpireMinutesValue: string | null
): TelegramGroupConfig {
  const chatId = chatIdValue?.trim() || null
  return {
    enabled,
    configured: Boolean(enabled && chatId),
    chatId,
    joinMode: normalizeGroupJoinMode(joinModeValue),
    minRecharge: parseNonNegativeAmount(minRechargeValue),
    minConsume: parseNonNegativeAmount(minConsumeValue),
    inviteExpireMinutes: parseInviteExpireMinutes(inviteExpireMinutesValue)
  }
}

async function getTelegramBotConfig(): Promise<TelegramBotConfig> {
  const [
    enabled,
    botUsernameValue,
    botToken,
    webhookSecret,
    groupEnabled,
    groupChatIdValue,
    groupJoinModeValue,
    groupMinRechargeValue,
    groupMinConsumeValue,
    groupInviteExpireMinutesValue,
    vipGroupEnabled,
    vipGroupChatIdValue,
    vipGroupJoinModeValue,
    vipGroupMinRechargeValue,
    vipGroupMinConsumeValue,
    vipGroupInviteExpireMinutesValue
  ] = await Promise.all([
    db.getSystemConfigBoolean('telegram_bot_enabled', false),
    db.getSystemConfig('telegram_bot_username'),
    db.getSystemConfig('telegram_bot_token'),
    db.getSystemConfig('telegram_webhook_secret'),
    db.getSystemConfigBoolean('telegram_group_join_enabled', false),
    db.getSystemConfig('telegram_group_chat_id'),
    db.getSystemConfig('telegram_group_join_mode'),
    db.getSystemConfig('telegram_group_min_recharge'),
    db.getSystemConfig('telegram_group_min_consume'),
    db.getSystemConfig('telegram_group_invite_expire_minutes'),
    db.getSystemConfigBoolean('telegram_vip_group_join_enabled', false),
    db.getSystemConfig('telegram_vip_group_chat_id'),
    db.getSystemConfig('telegram_vip_group_join_mode'),
    db.getSystemConfig('telegram_vip_group_min_recharge'),
    db.getSystemConfig('telegram_vip_group_min_consume'),
    db.getSystemConfig('telegram_vip_group_invite_expire_minutes')
  ])
  const botUsername = normalizeBotUsername(botUsernameValue)
  const webhookSecretValue = webhookSecret?.trim() || null
  const group = buildTelegramGroupConfig(
    groupEnabled,
    groupChatIdValue,
    groupJoinModeValue,
    groupMinRechargeValue,
    groupMinConsumeValue,
    groupInviteExpireMinutesValue
  )
  const vipGroup = buildTelegramGroupConfig(
    vipGroupEnabled,
    vipGroupChatIdValue,
    vipGroupJoinModeValue,
    vipGroupMinRechargeValue,
    vipGroupMinConsumeValue,
    vipGroupInviteExpireMinutesValue
  )

  return {
    enabled,
    configured: Boolean(enabled && botUsername && botToken && webhookSecretValue && isValidTelegramWebhookSecret(webhookSecretValue)),
    botUsername,
    botToken,
    webhookSecret: webhookSecretValue,
    group,
    vipGroup
  }
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<boolean> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  })

  return response.ok
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  payload?: Record<string, unknown>
): Promise<TelegramApiResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  })
  const data = await response.json().catch(() => null)

  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      description: `Telegram API returned HTTP ${response.status}`,
      error_code: response.status
    }
  }

  return data as TelegramApiResponse<T>
}

async function syncTelegramBotCommands(botToken: string): Promise<TelegramApiResponse<boolean>> {
  return callTelegramApi<boolean>(botToken, 'setMyCommands', {
    commands: telegramBotCommands
  })
}

function normalizeWebhookBaseUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null
  }
  return value || null
}

function buildWebhookUrl(request: FastifyRequest, baseUrl?: string): string | null {
  const explicitBaseUrl = baseUrl ? normalizeWebhookBaseUrl(baseUrl) : null
  if (explicitBaseUrl) {
    return `${explicitBaseUrl}/api/telegram/webhook`
  }

  const configuredBaseUrl = (process.env.SITE_URL || process.env.FRONTEND_URL?.split(',')[0])?.trim()
  if (configuredBaseUrl) {
    const normalized = normalizeWebhookBaseUrl(configuredBaseUrl)
    if (normalized) {
      return `${normalized}/api/telegram/webhook`
    }
  }

  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto'])
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host'])
  const host = forwardedHost || firstHeaderValue(request.headers.host) || request.hostname
  const proto = forwardedProto || request.protocol
  const normalized = normalizeWebhookBaseUrl(`${proto}://${host}`)
  return normalized ? `${normalized}/api/telegram/webhook` : null
}

function normalizeTelegramCommand(text: string): string {
  return text.trim().split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase()
}

function getGroupJoinTarget(text: string): TelegramGroupJoinTarget | null {
  const normalized = text.trim().toLowerCase()
  if (/^\/start\s+(join|group|apply_group)$/.test(normalized)) {
    return 'normal'
  }
  if (/^\/start\s+join_vip$/.test(normalized)) {
    return 'vip'
  }
  const command = normalizeTelegramCommand(text)
  if (telegramGroupCommands.has(command)) {
    return 'normal'
  }
  if (telegramVipGroupCommands.has(command)) {
    return 'vip'
  }
  return null
}

function formatMoney(value: number): string {
  return value.toFixed(2)
}

function parsePositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback
  }
  return Math.min(parsed, max)
}

function evaluateGroupEligibility(
  stats: { totalRecharge: number; totalConsume: number },
  group: TelegramGroupConfig
): { eligible: boolean; message: string } {
  const rechargeRequired = group.minRecharge > 0
  const consumeRequired = group.minConsume > 0

  if (!rechargeRequired && !consumeRequired) {
    return {
      eligible: true,
      message: '当前未设置金额门槛。'
    }
  }

  const rechargePassed = !rechargeRequired || stats.totalRecharge >= group.minRecharge
  const consumePassed = !consumeRequired || stats.totalConsume >= group.minConsume
  const eligible = group.joinMode === 'all'
    ? rechargePassed && consumePassed
    : (rechargeRequired && rechargePassed) || (consumeRequired && consumePassed)
  const requirements = [
    rechargeRequired ? `累计充值 ¥${formatMoney(group.minRecharge)}（当前 ¥${formatMoney(stats.totalRecharge)}）` : null,
    consumeRequired ? `累计消费 ¥${formatMoney(group.minConsume)}（当前 ¥${formatMoney(stats.totalConsume)}）` : null
  ].filter(Boolean)

  return {
    eligible,
    message: `${group.joinMode === 'all' ? '需同时满足' : '满足任一即可'}：${requirements.join('；')}`
  }
}

function buildAdminGroupEligibility(
  stats: { totalRecharge: number; totalConsume: number },
  group: TelegramGroupConfig,
  groupName = '私有群'
): {
  eligible: boolean
  status: 'eligible' | 'ineligible' | 'disabled' | 'unconfigured'
  message: string
  joinMode: TelegramGroupJoinMode
  minRecharge: number
  minConsume: number
} {
  if (!group.enabled) {
    return {
      eligible: false,
      status: 'disabled',
      message: `${groupName}入群申请未启用。`,
      joinMode: group.joinMode,
      minRecharge: group.minRecharge,
      minConsume: group.minConsume
    }
  }

  if (!group.configured) {
    return {
      eligible: false,
      status: 'unconfigured',
      message: `${groupName} Chat ID 未配置。`,
      joinMode: group.joinMode,
      minRecharge: group.minRecharge,
      minConsume: group.minConsume
    }
  }

  const eligibility = evaluateGroupEligibility(stats, group)
  return {
    eligible: eligibility.eligible,
    status: eligibility.eligible ? 'eligible' : 'ineligible',
    message: eligibility.message,
    joinMode: group.joinMode,
    minRecharge: group.minRecharge,
    minConsume: group.minConsume
  }
}

export default async function telegramRoutes(fastify: FastifyInstance) {
  // 取群/频道标题（把 -100xxxx 显示成群名），带内存缓存
  fastify.get<{ Querystring: { chatId?: string } }>(
    '/admin/chat-title',
    { onRequest: [fastify.authenticate, fastify.requireAdmin] },
    async (request) => {
      const chatId = String(request.query?.chatId || '').trim()
      if (!chatId) return { title: '' }
      const hit = chatTitleCache.get(chatId)
      if (hit) return { title: hit }
      const tokens: string[] = []
      try {
        const bind = await getTgBindSettings()
        if (bind.botToken) tokens.push(bind.botToken)
      } catch { /* 忽略 */ }
      try {
        const cfg = await getTelegramBotConfig()
        if (cfg.botToken && !tokens.includes(cfg.botToken)) tokens.push(cfg.botToken)
      } catch { /* 忽略 */ }
      for (const tk of tokens) {
        try {
          const r = await callTelegramApi<{ title?: string; username?: string; first_name?: string }>(
            tk, 'getChat', { chat_id: chatId }
          )
          const t = r?.result?.title || r?.result?.username || r?.result?.first_name || ''
          if (t) { chatTitleCache.set(chatId, t); return { title: t } }
        } catch { /* 换下一个 token */ }
      }
      return { title: '' }
    }
  )

  const telegramBindingModel = (prisma as any).userTelegramBinding
  const telegramBindTokenModel = (prisma as any).telegramBindToken

  async function notifyTelegram(botToken: string, chatId: number, text: string): Promise<void> {
    try {
      const sent = await sendTelegramMessage(botToken, chatId, text)
      if (!sent) {
        fastify.log.warn({ chatId }, 'Telegram message API returned non-OK response')
      }
    } catch (error) {
      fastify.log.warn({ err: error, chatId }, 'Failed to send Telegram message')
    }
  }

  function serializeGroupConfig(group: TelegramGroupConfig) {
    return {
      enabled: group.enabled,
      configured: group.configured,
      joinMode: group.joinMode,
      minRecharge: group.minRecharge,
      minConsume: group.minConsume
    }
  }

  async function buildAdminBindingView(binding: any, group: TelegramGroupConfig, vipGroup: TelegramGroupConfig) {
    const stats = await db.getUserConsumeStats(binding.userId)
    const eligibility = buildAdminGroupEligibility(stats, group, '普通群')
    const vipEligibility = buildAdminGroupEligibility(stats, vipGroup, '高级群')

    return {
      id: binding.id,
      userId: binding.userId,
      user: binding.user ? {
        id: binding.user.id,
        username: binding.user.username,
        email: binding.user.email,
        status: binding.user.status
      } : null,
      telegramUserId: binding.telegramUserId,
      telegramUsername: binding.telegramUsername,
      firstName: binding.firstName,
      lastName: binding.lastName,
      boundAt: binding.boundAt.toISOString(),
      updatedAt: binding.updatedAt.toISOString(),
      stats: {
        totalRecharge: stats.totalRecharge,
        totalConsume: stats.totalConsume,
        totalRefund: stats.totalRefund,
        totalDestroyedValue: stats.totalDestroyedValue
      },
      eligibility,
      vipEligibility
    }
  }

  async function isTelegramUserInGroup(
    botToken: string,
    groupChatId: string,
    telegramUserId: number
  ): Promise<boolean | null> {
    const response = await callTelegramApi<TelegramChatMember>(botToken, 'getChatMember', {
      chat_id: groupChatId,
      user_id: telegramUserId
    })

    if (!response.ok || !response.result) {
      return null
    }

    return !['left', 'kicked'].includes(response.result.status)
  }

  async function createGroupInviteLink(
    botToken: string,
    group: TelegramGroupConfig,
    inviteName: string
  ): Promise<{ inviteLink?: string; error?: string; errorCode?: number }> {
    if (!group.chatId) {
      return { error: 'Telegram group chat ID is not configured' }
    }

    const expireDate = Math.floor(Date.now() / 1000) + group.inviteExpireMinutes * 60
    const response = await callTelegramApi<TelegramInviteLinkResult>(botToken, 'createChatInviteLink', {
      chat_id: group.chatId,
      expire_date: expireDate,
      member_limit: 1,
      name: inviteName
    })

    if (!response.ok || !response.result?.invite_link) {
      return {
        error: response.description || 'Telegram invite link creation failed',
        errorCode: response.error_code
      }
    }

    return { inviteLink: response.result.invite_link }
  }

  async function handleGroupJoinRequest(
    config: TelegramBotConfig,
    chatId: number,
    from: TelegramWebhookUser,
    chatType: string | undefined,
    target: TelegramGroupJoinTarget
  ): Promise<void> {
    if (!config.botToken) {
      return
    }

    const group = target === 'vip' ? config.vipGroup : config.group
    const groupName = target === 'vip' ? '高级用户群' : '普通用户群'
    const command = target === 'vip' ? '/join_vip' : '/join'
    const inviteName = target === 'vip' ? 'Incudal VIP access' : 'Incudal user access'

    if (chatType && chatType !== 'private') {
      await notifyTelegram(config.botToken, chatId, `请私聊机器人发送 ${command} 申请${groupName}，避免邀请链接泄露到群聊。`)
      return
    }

    if (!group.enabled || !group.configured) {
      await notifyTelegram(config.botToken, chatId, `${groupName}申请暂未开放，请稍后再试或联系管理员。`)
      return
    }

    const telegramUserId = String(from.id)
    const binding = await telegramBindingModel.findUnique({
      where: { telegramUserId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            status: true
          }
        }
      }
    })

    if (!binding?.user) {
      await notifyTelegram(config.botToken, chatId, `请先登录网站，在个人设置里完成 Telegram 绑定后再发送 ${command}。`)
      return
    }

    if (binding.user.status !== 'active') {
      await notifyTelegram(config.botToken, chatId, '你的站内账号当前不可用，暂不能申请入群。')
      return
    }

    const stats = await db.getUserConsumeStats(binding.user.id)
    const eligibility = evaluateGroupEligibility(stats, group)
    if (!eligibility.eligible) {
      await notifyTelegram(
        config.botToken,
        chatId,
        `暂未达到${groupName}入群条件。\n${eligibility.message}`
      )
      return
    }

    if (group.chatId) {
      const alreadyInGroup = await isTelegramUserInGroup(config.botToken, group.chatId, from.id)
      if (alreadyInGroup) {
        await notifyTelegram(config.botToken, chatId, `你已经在${groupName}内，无需重复申请。`)
        return
      }
    }

    const inviteResult = await createGroupInviteLink(config.botToken, group, inviteName)
    if (!inviteResult.inviteLink) {
      fastify.log.warn(
        { err: inviteResult.error, errorCode: inviteResult.errorCode },
        'Telegram group invite link creation failed'
      )
      await notifyTelegram(config.botToken, chatId, '生成邀请链接失败，请联系管理员检查机器人群管理员权限。')
      return
    }

    await notifyTelegram(
      config.botToken,
      chatId,
      `已达标，可以加入${groupName}。\n${eligibility.message}\n\n一次性邀请链接：${inviteResult.inviteLink}\n有效期：${group.inviteExpireMinutes} 分钟。`
    )
  }

  fastify.get('/admin/webhook/info', {
    onRequest: [fastify.authenticateAdmin]
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.botToken) {
      return reply.code(400).send({ error: 'Telegram bot token is not configured' })
    }

    const telegramResponse = await callTelegramApi<TelegramWebhookInfo>(config.botToken, 'getWebhookInfo')
    if (!telegramResponse.ok) {
      return reply.code(502).send({
        error: telegramResponse.description || 'Telegram webhook info request failed',
        errorCode: telegramResponse.error_code
      })
    }

    return {
      info: telegramResponse.result
    }
  })

  fastify.post<{ Body: { baseUrl?: string } }>('/admin/webhook/setup', {
    onRequest: [fastify.authenticateAdmin],
    schema: {
      body: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: { baseUrl?: string } }>, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.botToken) {
      return reply.code(400).send({ error: 'Telegram bot token is not configured' })
    }
    if (!config.webhookSecret) {
      return reply.code(400).send({ error: 'Telegram webhook secret is not configured' })
    }
    if (!isValidTelegramWebhookSecret(config.webhookSecret)) {
      return reply.code(400).send({
        error: 'Telegram webhook secret can only contain letters, numbers, underscores, and hyphens',
        code: 'TELEGRAM_WEBHOOK_SECRET_INVALID'
      })
    }

    const webhookUrl = buildWebhookUrl(request, request.body?.baseUrl)
    if (!webhookUrl) {
      return reply.code(400).send({ error: 'Unable to build Telegram webhook URL' })
    }

    const telegramResponse = await callTelegramApi<boolean>(config.botToken, 'setWebhook', {
      url: webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ['message']
    })
    if (!telegramResponse.ok) {
      return reply.code(502).send({
        error: telegramResponse.description || 'Telegram webhook setup failed',
        errorCode: telegramResponse.error_code,
        webhookUrl
      })
    }

    const commandsResponse = await syncTelegramBotCommands(config.botToken)
    if (!commandsResponse.ok) {
      return reply.code(502).send({
        error: commandsResponse.description || 'Telegram bot command setup failed',
        errorCode: commandsResponse.error_code,
        webhookUrl,
        webhookConfigured: true
      })
    }

    return {
      message: 'Telegram webhook configured',
      webhookUrl,
      commandsSynced: true,
      commands: telegramBotCommands,
      result: telegramResponse.result
    }
  })

  fastify.post('/admin/webhook/delete', {
    onRequest: [fastify.authenticateAdmin]
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.botToken) {
      return reply.code(400).send({ error: 'Telegram bot token is not configured' })
    }

    const telegramResponse = await callTelegramApi<boolean>(config.botToken, 'deleteWebhook')
    if (!telegramResponse.ok) {
      return reply.code(502).send({
        error: telegramResponse.description || 'Telegram webhook delete failed',
        errorCode: telegramResponse.error_code
      })
    }

    return {
      message: 'Telegram webhook deleted',
      result: telegramResponse.result
    }
  })

  fastify.get<{ Querystring: TelegramAdminBindingsQuery }>('/admin/bindings', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request: FastifyRequest<{ Querystring: TelegramAdminBindingsQuery }>) => {
    const page = parsePositiveInteger(request.query.page, 1, 100000)
    const pageSize = parsePositiveInteger(request.query.pageSize, 5, 100)
    const search = request.query.search?.trim()
    const config = await getTelegramBotConfig()
    const where: any = {}

    if (search) {
      const or: any[] = [
        { telegramUserId: { contains: search } },
        { telegramUsername: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { user: { username: { contains: search } } },
        { user: { email: { contains: search } } }
      ]

      if (/^\d+$/.test(search)) {
        const numericSearch = Number(search)
        if (Number.isSafeInteger(numericSearch)) {
          or.push({ id: numericSearch }, { userId: numericSearch })
        }
      }

      where.OR = or
    }

    const [bindings, total] = await Promise.all([
      telegramBindingModel.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              status: true
            }
          }
        },
        orderBy: { boundAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      telegramBindingModel.count({ where })
    ])

    return {
      bindings: await Promise.all(bindings.map((binding: any) => buildAdminBindingView(binding, config.group, config.vipGroup))),
      total,
      page,
      pageSize,
      group: serializeGroupConfig(config.group),
      vipGroup: serializeGroupConfig(config.vipGroup)
    }
  })

  fastify.delete<{ Params: TelegramAdminBindingParams }>('/admin/bindings/:id', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request: FastifyRequest<{ Params: TelegramAdminBindingParams }>, reply: FastifyReply) => {
    const bindingId = Number.parseInt(request.params.id, 10)
    if (!Number.isSafeInteger(bindingId) || bindingId < 1) {
      return reply.code(400).send({ error: 'Invalid Telegram binding ID' })
    }

    const binding = await telegramBindingModel.findUnique({
      where: { id: bindingId },
      include: {
        user: {
          select: {
            id: true,
            username: true
          }
        }
      }
    })

    if (!binding) {
      return reply.code(404).send({ error: 'Telegram binding not found' })
    }

    await telegramBindingModel.delete({
      where: { id: bindingId }
    })

    // 管理员解绑 = 后台放行：清掉冷却，用户可立即重新绑定
    await prisma.user.update({
      where: { id: binding.userId },
      data: { tgBindChangedAt: null }
    })

    await createLog(
      request.user.id,
      'system',
      'telegram.binding_unlink',
      `Admin unlinked Telegram binding for user #${binding.userId} (${binding.user?.username || 'unknown'})`,
      'success'
    )

    return { message: 'Telegram binding removed' }
  })

  fastify.get('/binding', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest) => {
    const config = await getTelegramBotConfig()
    const binding = await telegramBindingModel.findUnique({
      where: { userId: request.user.id }
    })

    // 直接填 TGID 绑定是否可用：由「桥接设置」里的独立配置决定（不依赖 TG 设置卡片 / webhook）
    const tgBind = await getTgBindSettings()
    return {
      enabled: config.enabled,
      configured: config.configured,
      botUsername: config.botUsername,
      tgidBindAvailable: tgBind.available,
      binding: binding ? {
        telegramUserId: binding.telegramUserId,
        telegramUsername: binding.telegramUsername,
        firstName: binding.firstName,
        lastName: binding.lastName,
        boundAt: binding.boundAt.toISOString()
      } : null
    }
  })

  fastify.post('/bind-token', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const config = await getTelegramBotConfig()
    if (!config.configured || !config.botUsername) {
      return reply.code(400).send({ error: 'Telegram bot is not configured' })
    }

    await telegramBindTokenModel.deleteMany({
      where: {
        userId: request.user.id,
        usedAt: null
      }
    })

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + bindTokenTtlMs)

    await telegramBindTokenModel.create({
      data: {
        userId: request.user.id,
        tokenHash: hashToken(token),
        expiresAt
      }
    })

    return {
      bindUrl: `https://t.me/${config.botUsername}?start=${bindTokenPrefix}${token}`,
      expiresAt: expiresAt.toISOString()
    }
  })

  // POST /api/telegram/bind-by-tgid —— 用户直接填 TGID，面板调 Telegram API 校验在不在群 + 取全名
  // 注意：getChatMember 只是 API 调用，**不需要设 webhook**，所以不会和外部机器人抢 webhook。
  // 前提：面板配置的机器人 Token 对应的 bot 必须已经在目标群里。
  fastify.post<{ Body: { tgUserId?: string } }>('/bind-by-tgid', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest<{ Body: { tgUserId?: string } }>, reply: FastifyReply) => {
    // 配置全部来自「桥接设置」里的 TGID 绑定项，**完全独立于「TG 设置」卡片**。
    // 只用 getChatMember 做纯 API 调用，不涉及 webhook，所以不会和外部机器人抢。
    const tgBind = await getTgBindSettings()
    if (!tgBind.enabled) {
      return reply.code(400).send({ error: '管理员未开启 TGID 绑定' })
    }
    if (!tgBind.botToken) {
      return reply.code(400).send({ error: '未配置「TGID 绑定用的 Bot Token」（TG管理 → 设置）' })
    }
    const groupChatId = tgBind.groupChatId
    if (!groupChatId) {
      return reply.code(400).send({ error: '未配置「TGID 绑定群 Chat ID」（TG管理 → 设置）' })
    }

    const raw = String(request.body?.tgUserId ?? '').trim()
    if (!/^\d{4,20}$/.test(raw)) {
      return reply.code(400).send({ error: 'TGID 格式不正确（应为 4~20 位纯数字）' })
    }

    // 1) 调 Telegram 校验是否在群，顺带拿到成员资料（全名）
    const memberResp = await callTelegramApi<TelegramChatMember>(tgBind.botToken, 'getChatMember', {
      chat_id: groupChatId,
      user_id: Number(raw)
    })
    if (!memberResp.ok || !memberResp.result) {
      return reply.code(400).send({
        error: memberResp.description || '无法查询该 TGID：请确认 ID 正确，且面板机器人已加入该群'
      })
    }
    const status = String(memberResp.result.status || '')
    if (status === 'left' || status === 'kicked') {
      return reply.code(400).send({ error: '该 TGID 不在群组中，请先加入群组再绑定' })
    }

    const tgUser = memberResp.result.user
    const firstName = tgUser?.first_name || null
    const lastName = tgUser?.last_name || null
    const username = tgUser?.username || null

    // 2) 唯一性：这个 TGID 不能已绑到别的面板账号（DB 层 telegram_user_id 也是 UNIQUE）
    const existing = await telegramBindingModel.findUnique({ where: { telegramUserId: raw } })
    if (existing && existing.userId !== request.user.id) {
      return reply.code(409).send({ error: '该 TGID 已绑定到另一个面板账号' })
    }

    // 3) 写入/更新绑定（一个面板账号只保留一条）
    const now = new Date()
    // 已绑定且换成别的 TGID = 换绑，同样受一个月一次的限制
    const existingBinding = await telegramBindingModel.findUnique({
      where: { userId: request.user.id },
      select: { telegramUserId: true }
    })
    if (existingBinding && String(existingBinding.telegramUserId) !== raw) {
      const remain = await tgBindCooldownRemainDays(request.user.id)
      if (remain > 0) {
        return reply.code(429).send({
          error: `TG 换绑每月只能一次，还需 ${remain} 天。如确需换绑，请联系管理员在后台「用户管理」中处理`
        })
      }
    }

    const binding = await telegramBindingModel.upsert({
      where: { userId: request.user.id },
      update: { telegramUserId: raw, telegramUsername: username, firstName, lastName, boundAt: now },
      create: { userId: request.user.id, telegramUserId: raw, telegramUsername: username, firstName, lastName, boundAt: now }
    })

    // 任何一次绑定都开始 30 天计时（不只是换绑）：
    // 否则管理员解绑后，用户可以「绑定 → 解绑 → 再绑定」无限循环
    // （绑定不计时 → 解绑时冷却为 0 被放行 → 循环）
    await markTgBindChanged(request.user.id)

    return {
      ok: true,
      binding: {
        telegramUserId: binding.telegramUserId,
        telegramUsername: binding.telegramUsername,
        firstName: binding.firstName,
        lastName: binding.lastName,
        fullName: [binding.firstName, binding.lastName].filter(Boolean).join(' ') || null,
        status,
        inGroup: true,
        boundAt: binding.boundAt.toISOString()
      }
    }
  })

  fastify.delete('/binding', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // 冷却：一个月只能解绑/换绑一次，中途要解绑只能管理员在后台处理
    const remain = await tgBindCooldownRemainDays(request.user.id)
    if (remain > 0) {
      return reply.code(429).send({
        error: `TG 解绑/换绑每月只能一次，还需 ${remain} 天。如确需解绑，请联系管理员在后台「用户管理」中处理`
      })
    }

    await telegramBindingModel.deleteMany({
      where: { userId: request.user.id }
    })
    await markTgBindChanged(request.user.id)

    return { message: 'Telegram binding removed' }
  })

  fastify.post<{ Body: TelegramWebhookUpdate }>('/webhook', async (
    request: FastifyRequest<{ Body: TelegramWebhookUpdate }>,
    reply: FastifyReply
  ) => {
    const config = await getTelegramBotConfig()
    if (!config.configured || !config.botToken) {
      return { ok: true }
    }

    if (config.webhookSecret) {
      const headerValue = request.headers['x-telegram-bot-api-secret-token']
      const secretFromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue
      if (!secretFromHeader || !secureEquals(secretFromHeader, config.webhookSecret)) {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
    }

    const message = request.body?.message
    const chatId = message?.chat?.id
    const chatType = message?.chat?.type
    const from = message?.from
    const text = message?.text?.trim()
    const bindTokenMatch = text?.match(/^\/start\s+bind_([A-Za-z0-9_-]{20,128})$/)

    if (!chatId || !from || !text) {
      return { ok: true }
    }

    const joinTarget = getGroupJoinTarget(text)
    if (joinTarget) {
      await handleGroupJoinRequest(config, chatId, from, chatType, joinTarget)
      return { ok: true }
    }

    if (!bindTokenMatch) {
      await notifyTelegram(
        config.botToken,
        chatId,
        '可用指令：\n绑定账号：请先登录网站，在个人设置里生成 Telegram 绑定链接。\n申请普通群：绑定后私聊发送 /join。\n申请高级群：绑定后私聊发送 /join_vip。'
      )
      return { ok: true }
    }

    const tokenHash = hashToken(bindTokenMatch[1])
    const now = new Date()
    const bindToken = await telegramBindTokenModel.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now }
      }
    })

    if (!bindToken) {
      await notifyTelegram(config.botToken, chatId, '绑定链接无效或已过期，请回到网站重新生成绑定链接。')
      return { ok: true }
    }

    const telegramUserId = String(from.id)
    const existingBinding = await telegramBindingModel.findUnique({
      where: { telegramUserId }
    })
    if (existingBinding && existingBinding.userId !== bindToken.userId) {
      await notifyTelegram(config.botToken, chatId, '这个 Telegram 账号已经绑定到另一个网站账号。')
      return { ok: true }
    }

    await telegramBindingModel.upsert({
      where: { userId: bindToken.userId },
      update: {
        telegramUserId,
        telegramUsername: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        boundAt: now
      },
      create: {
        userId: bindToken.userId,
        telegramUserId,
        telegramUsername: from.username || null,
        firstName: from.first_name || null,
        lastName: from.last_name || null,
        boundAt: now
      }
    })

    await telegramBindTokenModel.update({
      where: { id: bindToken.id },
      data: { usedAt: now }
    })

    await notifyTelegram(
      config.botToken,
      chatId,
      '绑定成功。你现在可以关闭 Telegram，回到网站个人设置查看状态。'
    )

    return { ok: true }
  })
}
