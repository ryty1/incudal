import assert from 'node:assert/strict'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import {
  findRateLimitRule,
  globalRateLimit
} from '../src/config/rate-limit.js'
import { buildRateLimitErrorResponse } from '../src/lib/rate-limit-error.js'

const app = Fastify()

app.addHook('onRoute', (routeOptions) => {
  const rule = findRateLimitRule(routeOptions.url, routeOptions.method as string)
  if (rule) {
    routeOptions.config = {
      ...routeOptions.config,
      rateLimit: {
        max: rule.max,
        timeWindow: rule.timeWindow
      }
    }
  }
})

await app.register(rateLimit, {
  global: true,
  max: globalRateLimit.max,
  timeWindow: globalRateLimit.timeWindow,
  keyGenerator: (request) => {
    const rule = findRateLimitRule(request.url, request.method)
    if (rule) {
      return `${request.ip}:${rule.path}`
    }
    return request.ip
  },
  errorResponseBuilder: buildRateLimitErrorResponse
})

app.post('/api/auth/register', async () => ({ ok: true }))

await app.ready()

try {
  const first = await app.inject({ method: 'POST', url: '/api/auth/register' })
  const second = await app.inject({ method: 'POST', url: '/api/auth/register' })
  const third = await app.inject({ method: 'POST', url: '/api/auth/register' })
  const fourth = await app.inject({ method: 'POST', url: '/api/auth/register' })

  assert.equal(first.statusCode, 200)
  assert.equal(first.headers['x-ratelimit-limit'], '3')
  assert.equal(second.statusCode, 200)
  assert.equal(third.statusCode, 200)
  assert.equal(fourth.statusCode, 429)

  console.log('rate-limit hook order: ok')
} finally {
  await app.close()
}
