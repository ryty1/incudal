/**
 * 机器人桥接密钥（BOT_BRIDGE_TOKEN）的读写。
 *
 * 存储：系统配置表 system_config 的 `bot_bridge_token`，在 SENSITIVE_CONFIG_KEYS 里 → 落库前加密。
 * 兜底：若系统配置为空，则读环境变量 BOT_BRIDGE_TOKEN，兼容原有的 .env 部署方式。
 *
 * 优先级：系统配置（后台可改，即时生效）> 环境变量。
 */

import { randomBytes } from 'node:crypto'
import { getSystemConfig, updateSystemConfigs, getSystemConfigValueWithUpdatedAt } from '../db/system-config.js'

const CONFIG_KEY = 'bot_bridge_token'

/** 读取桥接密钥；未配置返回空串（调用方据此 fail-closed）。 */
export async function getBotBridgeToken(): Promise<string> {
  try {
    const stored = await getSystemConfig(CONFIG_KEY)
    if (stored && stored.trim()) return stored.trim()
  } catch (err) {
    console.error('[BotBridge] 读取系统配置失败，回退环境变量:', err)
  }
  return String(process.env.BOT_BRIDGE_TOKEN || '').trim()
}

/** 写入桥接密钥（加密存储）；传空串 = 关闭机器人桥接。 */
export async function setBotBridgeToken(token: string): Promise<void> {
  await updateSystemConfigs([{ key: CONFIG_KEY, value: token.trim() }])
}

/** 生成一个强随机密钥（base64url，约 43 字符）。 */
export function generateBotBridgeToken(): string {
  return randomBytes(32).toString('base64url')
}

/** 是否存在环境变量兜底值（后台据此提示“来自 .env”）。 */
export function hasEnvBotBridgeToken(): boolean {
  return !!String(process.env.BOT_BRIDGE_TOKEN || '').trim()
}

/** 后台「设置」用：返回启用状态、来源、当前密钥与更新时间。 */
export async function getBotBridgeSettings(): Promise<{
  enabled: boolean
  source: 'db' | 'env' | 'none'
  token: string | null
  updatedAt: string | null
}> {
  const stored = await getSystemConfig(CONFIG_KEY)
  const dbValue = stored && stored.trim() ? stored.trim() : ''
  const envValue = String(process.env.BOT_BRIDGE_TOKEN || '').trim()
  const effective = dbValue || envValue

  let updatedAt: string | null = null
  if (dbValue) {
    const meta = await getSystemConfigValueWithUpdatedAt(CONFIG_KEY)
    updatedAt = meta.updatedAt
  }

  return {
    enabled: !!effective,
    source: dbValue ? 'db' : (envValue ? 'env' : 'none'),
    token: effective || null,
    updatedAt
  }
}

// ==================== 守护同步（不在群成员巡检）====================
// 面板侧决定「开关」与「周期」，机器人通过 /api/bot/guard/meta 读取后照此执行。
const GUARD_ENABLED_KEY = 'guard_enabled'
const GUARD_INTERVAL_KEY = 'guard_interval_minutes'
// 实例到期提醒（机器人 cron 读 /guard/meta 时取走）——**独立于守护开关**，
// 用户要求：到期提醒要有自己的开关，不和「守护同步」共用。
const EXPIRY_REMINDER_DAYS_KEY = 'expiry_reminder_days'
const EXPIRY_REMINDER_ENABLED_KEY = 'expiry_reminder_enabled'

export async function getGuardSettings(): Promise<{
  enabled: boolean
  intervalMinutes: number
  expiryReminderDays: number
  expiryReminderEnabled: boolean
}> {
  // 新装默认全关：守护同步、到期提醒都要管理员显式打开
  let enabled = false
  let intervalMinutes = 15
  let expiryReminderDays = 5
  let expiryReminderEnabled = false
  try {
    const raw = await getSystemConfig(GUARD_ENABLED_KEY)
    const v = String(raw ?? '').trim().toLowerCase()
    if (v !== '') enabled = v === '1' || v === 'true'
  } catch { /* 读失败按「关」兜底，新装默认关闭 */ }
  try {
    const n = Math.floor(Number(await getSystemConfig(GUARD_INTERVAL_KEY)))
    // 上限 30 天（43200 分钟）——支持「天」为单位的守护周期
    if (Number.isFinite(n) && n >= 1) intervalMinutes = Math.min(43200, n)
  } catch { /* 读失败按 15 分钟兜底 */ }
  try {
    const d = Math.floor(Number(await getSystemConfig(EXPIRY_REMINDER_DAYS_KEY)))
    // 1~90 天；0 视为「不提醒」也允许
    if (Number.isFinite(d) && d >= 0) expiryReminderDays = Math.min(90, d)
  } catch { /* 读失败按 5 天兜底 */ }
  try {
    const raw = await getSystemConfig(EXPIRY_REMINDER_ENABLED_KEY)
    const v = String(raw ?? '').trim().toLowerCase()
    // 读不到（老库没这个键）按「关」兜底，新装默认关闭
    if (v !== '') expiryReminderEnabled = v === '1' || v === 'true'
  } catch { /* 读失败按关兜底 */ }
  return { enabled, intervalMinutes, expiryReminderDays, expiryReminderEnabled }
}

/** 写入守护设置；只更新传入的字段。 */
export async function setGuardSettings(input: {
  enabled?: boolean
  intervalMinutes?: number
  expiryReminderDays?: number
  expiryReminderEnabled?: boolean
}): Promise<void> {
  const updates: Array<{ key: string; value: string }> = []
  if (input.enabled !== undefined) {
    updates.push({ key: GUARD_ENABLED_KEY, value: input.enabled ? '1' : '0' })
  }
  if (input.intervalMinutes !== undefined) {
    const n = Math.min(43200, Math.max(1, Math.floor(Number(input.intervalMinutes) || 15)))
    updates.push({ key: GUARD_INTERVAL_KEY, value: String(n) })
  }
  if (input.expiryReminderDays !== undefined) {
    const d = Math.min(90, Math.max(0, Math.floor(Number(input.expiryReminderDays) || 0)))
    updates.push({ key: EXPIRY_REMINDER_DAYS_KEY, value: String(d) })
  }
  if (input.expiryReminderEnabled !== undefined) {
    updates.push({ key: EXPIRY_REMINDER_ENABLED_KEY, value: input.expiryReminderEnabled ? '1' : '0' })
  }
  if (updates.length) await updateSystemConfigs(updates)
}

// ==================== TGID 绑定（独立于「TG 设置」卡片）====================
// 只做一件事：用 bot token 调 getChatMember，校验用户在不在群 + 取全名。
// 全程不涉及 webhook，所以可以直接复用任何「已经在群里」的 bot，不会和外部机器人冲突。
const TG_BIND_ENABLED_KEY = 'tg_bind_enabled'
const TG_BIND_TOKEN_KEY = 'tg_bind_bot_token'
const TG_BIND_GROUP_KEY = 'tg_bind_group_chat_id'

export async function getTgBindSettings(): Promise<{
  enabled: boolean
  botToken: string
  groupChatId: string
  /** 三项齐备才算可用（前端据此决定是否显示 TGID 输入框） */
  available: boolean
}> {
  let enabled = false
  let botToken = ''
  let groupChatId = ''
  try {
    const v = String((await getSystemConfig(TG_BIND_ENABLED_KEY)) ?? '').trim().toLowerCase()
    enabled = v === '1' || v === 'true'
  } catch { /* 读失败按「关」兜底 */ }
  try { botToken = String((await getSystemConfig(TG_BIND_TOKEN_KEY)) ?? '').trim() } catch { /* 忽略 */ }
  try { groupChatId = String((await getSystemConfig(TG_BIND_GROUP_KEY)) ?? '').trim() } catch { /* 忽略 */ }
  return { enabled, botToken, groupChatId, available: Boolean(enabled && botToken && groupChatId) }
}

/** 写入 TGID 绑定设置；只更新传入的字段。 */
export async function setTgBindSettings(input: { enabled?: boolean; botToken?: string; groupChatId?: string }): Promise<void> {
  const updates: Array<{ key: string; value: string }> = []
  if (input.enabled !== undefined) updates.push({ key: TG_BIND_ENABLED_KEY, value: input.enabled ? '1' : '0' })
  if (input.botToken !== undefined) updates.push({ key: TG_BIND_TOKEN_KEY, value: String(input.botToken).trim() })
  if (input.groupChatId !== undefined) updates.push({ key: TG_BIND_GROUP_KEY, value: String(input.groupChatId).trim() })
  if (updates.length) await updateSystemConfigs(updates)
}
