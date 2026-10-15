import assert from 'node:assert/strict'
import { findRateLimitRule } from '../src/config/rate-limit.js'

const registerRule = findRateLimitRule('/api/auth/register', 'POST')
assert.ok(registerRule, 'register route should have a dedicated rate-limit rule')
assert.ok(registerRule.max <= 3, 'register route should stay strictly rate limited')

const sendCodeRule = findRateLimitRule('/api/auth/send-verification-code', 'POST')
assert.ok(sendCodeRule, 'email verification send-code route should have a dedicated rate-limit rule')
assert.ok(sendCodeRule.max <= 5, 'email verification send-code route should be rate limited')

console.log('auth rate-limit rules: ok')
