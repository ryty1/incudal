import assert from 'node:assert/strict'
import { shouldVerifyTurnstileForRegister } from '../src/lib/register-turnstile.js'

assert.equal(
  shouldVerifyTurnstileForRegister(true),
  false,
  'register should not require Turnstile when email verification is enabled'
)

assert.equal(
  shouldVerifyTurnstileForRegister(false),
  true,
  'register should require Turnstile when email verification is disabled'
)

console.log('register Turnstile helper: ok')
