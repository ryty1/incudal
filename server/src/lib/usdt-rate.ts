/**
 * USDT/CNY 汇率（U付 USDT 渠道下单时用）
 *
 * 取价顺序（与 tg-antispam 里的实现保持一致）：
 *   1. 环境变量 USDT_CNY_RATE —— 人工锁定，生产环境推荐
 *   2. CoinGecko simple/price
 *   3. open.er-api.com（USD→CNY 兜底）
 * 结果缓存 10 分钟，避免每次下单都打外部接口。
 *
 * 注意：下单时要把「汇率 + USDT 金额」写进订单，回调按订单里的值校验，
 * 不要回调时再取一次价 —— 否则汇率波动会导致金额校验失败。
 */

const CACHE_TTL_MS = 10 * 60 * 1000
const MIN_RATE = 1
const MAX_RATE = 100

interface RateCache {
  rate: number
  source: string
  at: number
}

let cache: RateCache | null = null

function valid(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 取 CNY/USDT 汇率（1 USDT = ? CNY）。失败返回 null。 */
export async function getUsdtCnyRate(): Promise<{ rate: number; source: string } | null> {
  const envRate = Number(process.env.USDT_CNY_RATE || '')
  if (valid(envRate)) return { rate: envRate, source: 'env' }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { rate: cache.rate, source: cache.source }
  }

  // CoinGecko
  try {
    const data = (await fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cny'
    )) as { tether?: { cny?: number } }
    const rate = Number(data?.tether?.cny)
    if (valid(rate)) {
      cache = { rate, source: 'coingecko', at: Date.now() }
      return { rate, source: 'coingecko' }
    }
  } catch (err) {
    console.warn('[USDT] CoinGecko 取价失败:', (err as Error).message)
  }

  // er-api 兜底（USD→CNY）
  try {
    const data = (await fetchJson('https://open.er-api.com/v6/latest/USD')) as {
      rates?: { CNY?: number }
    }
    const rate = Number(data?.rates?.CNY)
    if (valid(rate)) {
      cache = { rate, source: 'er-api', at: Date.now() }
      return { rate, source: 'er-api' }
    }
  } catch (err) {
    console.warn('[USDT] er-api 取价失败:', (err as Error).message)
  }

  // 全部失败：有旧缓存就用旧的（宁可略偏也不要下不了单）
  if (cache) return { rate: cache.rate, source: cache.source + '(stale)' }
  return null
}

/** 人民币 → USDT 金额（两位小数，最小 0.01） */
export function cnyToUsdt(cny: number, rate: number): number {
  if (!Number.isFinite(cny) || !valid(rate) || cny <= 0) return 0
  const amount = Math.round((cny / rate) * 100) / 100
  return Math.max(0.01, amount)
}

/** 供后台/调试用：清掉缓存 */
export function clearUsdtRateCache(): void {
  cache = null
}
