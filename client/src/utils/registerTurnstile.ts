export function shouldShowRegisterTurnstileWidget(input: {
  turnstileEnabled: boolean
  hasSiteKey: boolean
  emailVerificationEnabled: boolean
  codeSent: boolean
  resendTurnstileRequested: boolean
}): boolean {
  if (!input.turnstileEnabled || !input.hasSiteKey) {
    return false
  }

  if (!input.emailVerificationEnabled) {
    return true
  }

  return !input.codeSent || input.resendTurnstileRequested
}

export function shouldRequireTurnstileForSendCode(input: {
  turnstileEnabled: boolean
  emailVerificationEnabled: boolean
  codeSent: boolean
  resendTurnstileRequested: boolean
}): boolean {
  return input.turnstileEnabled &&
    input.emailVerificationEnabled &&
    (!input.codeSent || input.resendTurnstileRequested)
}
