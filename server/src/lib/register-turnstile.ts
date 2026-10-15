export function shouldVerifyTurnstileForRegister(emailVerificationEnabled: boolean): boolean {
  return !emailVerificationEnabled
}
