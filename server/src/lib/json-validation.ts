/**
 * JSON 字段安全解析与验证工具
 *
 * 为数据库中 Json 类型字段提供安全的解析和基础结构验证，
 * 防止 JSON.parse 异常导致服务崩溃，并确保数据格式符合预期。
 */

// ==================== 安全解析 ====================

/**
 * 安全解析 JSON 值，支持已经是对象/数组的情况（Prisma 自动解析）
 * 如果解析失败，返回 fallback 值而不是抛出异常
 */
export function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback

  // Prisma 可能已经自动解析为对象
  if (typeof value === 'object') return value as T

  if (typeof value !== 'string') return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * 安全解析 JSON 字符串数组（如 Host.tags、Package.nodeSelectors）
 */
export function parseStringArray(value: unknown): string[] {
  const parsed = safeJsonParse<unknown>(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === 'string')
}

/**
 * 安全解析 JSON 对象（如 NotificationChannel.config、StorageConfig.extra）
 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, {})
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

// ==================== 结构验证 ====================

/**
 * 验证通知渠道配置结构
 * 支持 telegram / discord / email / webhook 四种类型
 */
export function validateNotificationConfig(type: string, config: unknown): {
  valid: boolean
  error?: string
} {
  const obj = parseJsonObject(config)

  switch (type) {
    case 'telegram':
      if (!obj.botToken || typeof obj.botToken !== 'string') {
        return { valid: false, error: 'Telegram config requires botToken (string)' }
      }
      if (!obj.chatId || (typeof obj.chatId !== 'string' && typeof obj.chatId !== 'number')) {
        return { valid: false, error: 'Telegram config requires chatId (string or number)' }
      }
      break

    case 'discord':
      if (!obj.webhookUrl || typeof obj.webhookUrl !== 'string') {
        return { valid: false, error: 'Discord config requires webhookUrl (string)' }
      }
      break

    case 'email':
      if (!obj.email || typeof obj.email !== 'string') {
        return { valid: false, error: 'Email config requires email (string)' }
      }
      break

    case 'webhook':
      if (!obj.url || typeof obj.url !== 'string') {
        return { valid: false, error: 'Webhook config requires url (string)' }
      }
      break

    default:
      return { valid: false, error: `Unknown notification channel type: ${type}` }
  }

  return { valid: true }
}

/**
 * 验证存储配置扩展字段结构
 */
export function validateStorageExtra(extra: unknown): {
  valid: boolean
  error?: string
} {
  if (extra === null || extra === undefined) return { valid: true }
  const obj = parseJsonObject(extra)
  // extra 字段为可选的扩展配置，只要是合法对象即可
  if (typeof obj !== 'object') {
    return { valid: false, error: 'Storage extra config must be a JSON object' }
  }
  return { valid: true }
}

/**
 * 验证节点选择器（字符串数组）
 */
export function validateNodeSelectors(value: unknown): {
  valid: boolean
  selectors: string[]
  error?: string
} {
  const selectors = parseStringArray(value)
  if (selectors.length > 50) {
    return { valid: false, selectors: [], error: 'Node selectors cannot exceed 50 items' }
  }
  // 每个选择器长度限制
  const tooLong = selectors.find(s => s.length > 100)
  if (tooLong) {
    return { valid: false, selectors: [], error: `Node selector too long: "${tooLong}" (max 100 chars)` }
  }
  return { valid: true, selectors }
}

/**
 * 验证标签数组（Host.tags）
 */
export function validateTags(value: unknown): {
  valid: boolean
  tags: string[]
  error?: string
} {
  const tags = parseStringArray(value)
  if (tags.length > 20) {
    return { valid: false, tags: [], error: 'Tags cannot exceed 20 items' }
  }
  const tooLong = tags.find(t => t.length > 50)
  if (tooLong) {
    return { valid: false, tags: [], error: `Tag too long: "${tooLong}" (max 50 chars)` }
  }
  return { valid: true, tags }
}
