/**
 * 机器人桥接鉴权（Machine-to-Machine）
 *
 * 用途：让外部机器人（tg-antispam 等）在不持有任何用户/管理员登录态的情况下调用面板数据。
 * 现有装饰器 authenticate / requireAdmin 走 JWT + 活跃访问令牌，机器人不是登录用户，用不了；
 * 把管理员 JWT 发给另一个进程等于把后台登录态外流，所以这里单独开一把共享密钥。
 *
 * 安全约束：
 *  - 密钥未配置时**拒绝一切请求**（fail closed），避免"忘配 token = 接口裸奔"。
 *  - 常数时间比较，防止时序侧信道逐字节猜密钥。
 *  - 只做鉴权，不放宽任何业务校验；路由仍需自行校验参数与归属。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual, createHash } from 'node:crypto'
import { getBotBridgeToken } from '../lib/bot-bridge-config.js'

const TOKEN_HEADER = 'x-bridge-token'
const AUTH_PREFIX = 'Bearer '

/** 从请求头里取出待校验令牌（支持 `Authorization: Bearer x` 与 `X-Bridge-Token: x` 两种写法）。 */
function extractToken(request: FastifyRequest): string {
  const header = request.headers[TOKEN_HEADER]
  if (typeof header === 'string' && header.trim()) return header.trim()

  const auth = request.headers.authorization
  if (typeof auth === 'string' && auth.startsWith(AUTH_PREFIX)) {
    const value = auth.slice(AUTH_PREFIX.length).trim()
    if (value) return value
  }
  return ''
}

/**
 * 恒定时间比较。
 * 两侧长度不同就直接返回 false——长度本身不构成可利用的时序泄漏，
 * 而直接用 `===` 会在第一个不同字节处返回，可被逐字节枚举。
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

export async function registerBotBridgeAuth(fastify: FastifyInstance): Promise<void> {
  fastify.decorate('authenticateBot', async function (request: FastifyRequest, reply: FastifyReply) {
    const configured = await getBotBridgeToken()
    if (!configured) {
      // 没配密钥 = 该能力未启用。返回 404 而非 401，避免向探测者暴露"存在这个接口"。
      return reply.code(404).send({ error: 'Not found' })
    }

    const presented = extractToken(request)
    if (!presented || !safeEqual(presented, configured)) {
      return reply.code(401).send({ error: 'Unauthorized', code: 'BRIDGE_UNAUTHORIZED' })
    }
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    /** 机器人桥接鉴权 preHandler：校验 BOT_BRIDGE_TOKEN 后放行。 */
    authenticateBot: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}
