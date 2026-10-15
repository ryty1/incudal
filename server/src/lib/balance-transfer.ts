export const MAX_USER_BALANCE = 99999999.99

/**
 * 四舍五入到分（两位小数），避免浮点精度问题。
 */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9
}

export function normalizeBalanceTransferAmount(value: unknown): number {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0.01 || amount > MAX_USER_BALANCE || !hasAtMostTwoDecimalPlaces(amount)) {
    throw new Error('BALANCE_TRANSFER_AMOUNT_INVALID')
  }
  return roundMoney(amount)
}

export function normalizeBalanceTransferFee(value: unknown): number {
  const fee = Number(value)
  if (!Number.isFinite(fee) || fee < 0 || fee > MAX_USER_BALANCE || !hasAtMostTwoDecimalPlaces(fee)) {
    throw new Error('BALANCE_TRANSFER_AMOUNT_INVALID')
  }
  return roundMoney(fee)
}

export function createBalanceTransferNo(): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).slice(2, 10).toUpperCase()
  return `BT${timestamp}${random}`
}
