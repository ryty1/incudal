import assert from 'node:assert/strict'
import { getStrictTurnstilePrecheck } from '../src/lib/turnstile-precheck.js'

const disabled = getStrictTurnstilePrecheck({ enabled: false, secretKey: null })
assert.deepEqual(disabled, { ok: true, skip: true }, 'strict verifier should skip when Turnstile is disabled')

const missingSecret = getStrictTurnstilePrecheck({ enabled: true, secretKey: null })
assert.deepEqual(missingSecret, {
  ok: false,
  statusCode: 503,
  payload: {
    error: 'Turnstile verification is not configured',
    code: 'TURNSTILE_NOT_CONFIGURED'
  }
})

const missingToken = getStrictTurnstilePrecheck({ enabled: true, secretKey: 'secret' })
assert.deepEqual(missingToken, {
  ok: false,
  statusCode: 400,
  payload: {
    error: 'Turnstile verification required',
    code: 'TURNSTILE_TOKEN_MISSING'
  }
})

const validToken = getStrictTurnstilePrecheck({ enabled: true, secretKey: 'secret' }, 'token')
assert.deepEqual(validToken, {
  ok: true,
  skip: false,
  secretKey: 'secret',
  token: 'token'
})

console.log('strict Turnstile precheck: ok')
