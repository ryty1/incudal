import assert from 'node:assert/strict'
import {
  shouldRequireTurnstileForSendCode,
  shouldShowRegisterTurnstileWidget
} from '../src/utils/registerTurnstile'

assert.equal(
  shouldShowRegisterTurnstileWidget({
    turnstileEnabled: true,
    hasSiteKey: true,
    emailVerificationEnabled: true,
    codeSent: false,
    resendTurnstileRequested: false
  }),
  true,
  'email verification flow should show Turnstile before the first code send'
)

assert.equal(
  shouldShowRegisterTurnstileWidget({
    turnstileEnabled: true,
    hasSiteKey: true,
    emailVerificationEnabled: true,
    codeSent: true,
    resendTurnstileRequested: false
  }),
  false,
  'email verification flow should hide Turnstile after code is sent'
)

assert.equal(
  shouldShowRegisterTurnstileWidget({
    turnstileEnabled: true,
    hasSiteKey: true,
    emailVerificationEnabled: true,
    codeSent: true,
    resendTurnstileRequested: true
  }),
  true,
  'email verification flow should show Turnstile when user requests resend'
)

assert.equal(
  shouldShowRegisterTurnstileWidget({
    turnstileEnabled: true,
    hasSiteKey: true,
    emailVerificationEnabled: false,
    codeSent: false,
    resendTurnstileRequested: false
  }),
  true,
  'non-email verification flow should show Turnstile for register submit'
)

assert.equal(
  shouldRequireTurnstileForSendCode({
    turnstileEnabled: true,
    emailVerificationEnabled: true,
    codeSent: true,
    resendTurnstileRequested: false
  }),
  false,
  'sent-code state should not require a second Turnstile before register submit'
)

console.log('register Turnstile UI helper: ok')
