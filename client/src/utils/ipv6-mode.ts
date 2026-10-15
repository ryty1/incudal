/**
 * 节点 IPv6 模式三态（对应后端 hosts.ipv6_mode）：
 *
 *   1 = IPv4 NAT + 独立 IPv6  —— 从子网给容器分配独立公网 IPv6（需 /64 或更短前缀）
 *   2 = IPv4 NAT + IPv6 NAT  —— 共享宿主机单个公网 IPv6 出口（不需要子网）
 *   3 = 纯 IPv4              —— 不启用 IPv6
 *
 * 兼容说明：历史节点被存成 ipv6Mode=1 且 ipv6Subnet 填了节点自己的 /128
 * （安装脚本默认值造成的）。这类数据按「共享 IPv6」展示，不迁移数据库。
 */

export type HostIpv6Mode = 1 | 2 | 3 | 4 | 5

/** 取 CIDR 前缀长度；不是合法 CIDR 返回 null */
export function ipv6PrefixLength(subnet?: string | null): number | null {
  const match = String(subnet || '').match(/\/(\d{1,3})\s*$/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value >= 0 && value <= 128 ? value : null
}

/** 子网是否真的能分配给多个容器（前缀 <= /64） */
export function isIndependentIpv6Subnet(subnet?: string | null): boolean {
  const prefix = ipv6PrefixLength(subnet)
  return prefix !== null && prefix <= 64
}

/** 把库里的 ipv6_mode + ipv6_subnet 推导成前端三态 */
export function deriveHostIpv6Mode(ipv6Mode?: number | null, ipv6Subnet?: string | null): HostIpv6Mode {
  const mode = Number(ipv6Mode ?? 0)
  if (mode === 3) return 3
  if (mode === 2) return 2
  return isIndependentIpv6Subnet(ipv6Subnet) ? 1 : 2
}
