/**
 * 「墙」判定
 *
 * 规则：节点在线的前提下，最近一轮上报里**所有**三网 IPv4 探测点
 * （广东/上海 × 联通/移动/电信，即 gd-*-v4 / sh-*-v4）都是 100% 丢包，
 * 就认为这个节点到大陆的 IPv4 不通（墙）。
 *
 * - cn-bd-v4 / us-cf-v4 是出站自检，不参与判定
 * - 纯 IPv6 节点没有 v4 采样，天然不会命中
 * - 数据来自 /api/hosts/latency/summary 的 hosts 字段（每个探测点最新一次采样）
 */
const SANHE_V4 = /^(gd|sh)-[a-z]{2}-v4$/

export interface LatencySummaryLike {
  hosts?: Record<string, Record<string, { lossPct?: number | null } | null | undefined>>
}

export function computeWallHostIds(summary: LatencySummaryLike | null | undefined): Set<number> {
  const ids = new Set<number>()
  const byHost = summary?.hosts || {}
  for (const [hostId, probes] of Object.entries(byHost)) {
    const v4 = Object.entries(probes || {}).filter(([key]) => SANHE_V4.test(key))
    if (!v4.length) continue
    if (v4.every(([, v]) => (v?.lossPct ?? 0) >= 100)) ids.add(Number(hostId))
  }
  return ids
}
