import type { HeleketConfig, HeleketPayment } from './heleket.js'
import { extractHeleketPaymentDetails, getHeleketInvoiceAmount } from './heleket.js'

export interface RechargePaymentDetails {
  kind?: string
  recharge?: {
    amount?: number | null
    payableAmount?: number | null
    fee?: number | null
    feeRate?: number | null
    feeFixed?: number | null
    feeMode?: 'surcharge' | 'deduct'
    paymentMethod?: string | null
  }
  /** 法币→加密货币渠道（如 U付 USDT）：下单时锁定金额与汇率，回调按它校验 */
  crypto?: {
    currency?: string | null       // 'USDT'
    amount?: number | null         // 应支付的币种数量
    rate?: number | null           // 下单时锁定的汇率（CNY/USDT）
    rateSource?: string | null     // env | coingecko | er-api | manual
  }
  heleket?: {
    invoiceCurrency?: string | null
    invoiceAmount?: number | null
    lifetimeSeconds?: number | null
    orderId?: string | null
    status?: string | null
    statusDescription?: string | null
    uuid?: string | null
    txid?: string | null
    payerCurrency?: string | null
    network?: string | null
    paymentMethodCode?: string | null
    paymentAmount?: string | null
    paymentAmountUsd?: string | null
    merchantAmount?: string | null
    address?: string | null
    from?: string | null
  }
}

export interface RechargePaymentDisplayInfo {
  invoiceCurrency: string | null
  paymentCurrency: string | null
  paymentNetwork: string | null
  actualPaymentMethod: string | null
  paymentUuid: string | null
  paymentTxid: string | null
  gatewayStatus: string | null
  gatewayStatusDescription: string | null
}

export function readRechargePaymentDetails(value: unknown): RechargePaymentDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as RechargePaymentDetails
}

export function buildHeleketInvoicePaymentDetails(
  orderNo: string,
  amount: number,
  config: HeleketConfig
): RechargePaymentDetails {
  return {
    kind: 'heleket',
    heleket: {
      orderId: orderNo,
      invoiceCurrency: config.currency || 'CNY',
      invoiceAmount: amount,
      lifetimeSeconds: config.lifetimeSeconds
    }
  }
}

export function mergeRechargeAmountDetails(
  existingValue: unknown,
  input: {
    amount: number
    payableAmount: number
    fee: number
    feeRate: number
    feeFixed: number
    feeMode?: 'surcharge' | 'deduct'
    paymentMethod?: string | null
    crypto?: RechargePaymentDetails['crypto']
  }
): RechargePaymentDetails {
  const existing = readRechargePaymentDetails(existingValue)

  return {
    ...existing,
    ...(input.crypto ? { crypto: input.crypto } : {}),
    recharge: {
      ...existing.recharge,
      amount: input.amount,
      payableAmount: input.payableAmount,
      fee: input.fee,
      feeRate: input.feeRate,
      feeFixed: input.feeFixed,
      feeMode: input.feeMode || 'surcharge',
      paymentMethod: input.paymentMethod || null
    }
  }
}

export function getRechargePayableAmount(record: { amount: unknown; fee?: unknown; paymentDetails?: unknown }): number {
  const paymentDetails = readRechargePaymentDetails(record.paymentDetails)
  const configuredPayableAmount = paymentDetails.recharge?.payableAmount

  if (configuredPayableAmount !== undefined && configuredPayableAmount !== null) {
    const amount = Number(configuredPayableAmount)
    if (Number.isFinite(amount) && amount > 0) {
      return amount
    }
  }

  return Number(record.amount)
}

export function mergeHeleketPaymentDetails(
  existingValue: unknown,
  payment: HeleketPayment | Record<string, unknown>,
  config?: Partial<HeleketConfig>,
  fallback?: {
    orderNo?: string
    invoiceAmount?: number
  }
): RechargePaymentDetails {
  const existing = readRechargePaymentDetails(existingValue)
  const heleketDetails = extractHeleketPaymentDetails(payment)
  const invoiceAmount = getHeleketInvoiceAmount(payment)

  return {
    ...existing,
    kind: 'heleket',
    heleket: {
      ...existing.heleket,
      orderId: fallback?.orderNo || existing.heleket?.orderId || null,
      invoiceCurrency: config?.currency || existing.heleket?.invoiceCurrency || null,
      invoiceAmount: invoiceAmount ?? fallback?.invoiceAmount ?? existing.heleket?.invoiceAmount ?? null,
      lifetimeSeconds: config?.lifetimeSeconds ?? existing.heleket?.lifetimeSeconds ?? null,
      status: heleketDetails.status,
      statusDescription: heleketDetails.statusDescription,
      uuid: heleketDetails.uuid,
      txid: heleketDetails.txid,
      payerCurrency: heleketDetails.payerCurrency,
      network: heleketDetails.network,
      paymentMethodCode: heleketDetails.paymentMethodCode,
      paymentAmount: heleketDetails.paymentAmount,
      paymentAmountUsd: heleketDetails.paymentAmountUsd,
      merchantAmount: heleketDetails.merchantAmount,
      address: heleketDetails.address,
      from: heleketDetails.from
    }
  }
}

export function extractRechargePaymentDisplayInfo(value: unknown): RechargePaymentDisplayInfo {
  const details = readRechargePaymentDetails(value)
  const heleket = details.heleket

  return {
    invoiceCurrency: heleket?.invoiceCurrency || null,
    paymentCurrency: heleket?.payerCurrency || null,
    paymentNetwork: heleket?.network || null,
    actualPaymentMethod: heleket?.paymentMethodCode || null,
    paymentUuid: heleket?.uuid || null,
    paymentTxid: heleket?.txid || null,
    gatewayStatus: heleket?.status || null,
    gatewayStatusDescription: heleket?.statusDescription || null
  }
}
