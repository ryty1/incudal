function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function assertThrows(fn: () => unknown, expectedMessage: string, message: string) {
  try {
    fn()
  } catch (error) {
    const actualMessage = error instanceof Error ? error.message : String(error)
    assertEqual(actualMessage, expectedMessage, message)
    return
  }

  throw new Error(`${message}: expected function to throw ${expectedMessage}`)
}

const {
  normalizeBalanceTransferAmount,
  normalizeBalanceTransferFee,
} = await import('../src/lib/balance-transfer.js')

assertEqual(normalizeBalanceTransferAmount(10), 10, 'accepts integer amount')
assertEqual(normalizeBalanceTransferAmount(10.12), 10.12, 'accepts cent amount')
assertEqual(normalizeBalanceTransferFee(1.01), 1.01, 'accepts cent fee')
assertThrows(
  () => normalizeBalanceTransferAmount(0),
  'BALANCE_TRANSFER_AMOUNT_INVALID',
  'rejects zero amount'
)
assertThrows(
  () => normalizeBalanceTransferAmount(10.129),
  'BALANCE_TRANSFER_AMOUNT_INVALID',
  'rejects amount with more than two decimal places'
)
assertThrows(
  () => normalizeBalanceTransferFee(1.005),
  'BALANCE_TRANSFER_AMOUNT_INVALID',
  'rejects fee with more than two decimal places'
)
assertThrows(
  () => normalizeBalanceTransferAmount(100000000),
  'BALANCE_TRANSFER_AMOUNT_INVALID',
  'rejects amount above balance decimal range'
)

console.log('Balance transfer helper tests passed')
