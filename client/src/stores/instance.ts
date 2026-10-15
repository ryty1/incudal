import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import type { DashboardSummary, Instance } from '@/types/api'

/**
 * 实例列表共享 Store
 *
 * DashboardView 调用 fetchDashboardSummary() 获取轻量统计摘要（状态计数 + 最近 5 条实例），
 * 不再全量拉取实例列表。InstancesView 仍使用自己的分页查询。
 */
export const useInstanceStore = defineStore('instance', () => {
  // Dashboard 统计摘要缓存
  const summary = ref<DashboardSummary | null>(null)
  const lastFetchTime = ref(0)
  const loading = ref(false)

  // 缓存有效期：3 分钟内复用，避免频繁拉取
  const STALE_TIME = 3 * 60 * 1000

  /**
   * 获取 Dashboard 统计摘要（带缓存）
   * 替代旧的 pageSize:1000 全量拉取，仅返回状态计数 + 最近 5 条实例
   * @param force 是否强制刷新（忽略缓存）
   * @returns 摘要数据
   */
  async function fetchDashboardSummary(force = false): Promise<DashboardSummary | null> {
    const now = Date.now()

    // 缓存有效且非强制刷新，直接返回缓存
    if (!force && summary.value && now - lastFetchTime.value < STALE_TIME) {
      return summary.value
    }

    loading.value = true
    try {
      const data = await api.instances.getDashboardSummary()
      summary.value = data
      lastFetchTime.value = now
    } catch {
      // 静默失败，保留上次缓存
    } finally {
      loading.value = false
    }
    return summary.value
  }

  /**
   * 获取最近 N 条实例（用于 Dashboard 概览卡片）
   */
  function getRecentInstances(count = 5): Instance[] {
    return summary.value?.recentInstances?.slice(0, count) || []
  }

  /**
   * 清除缓存（登出或需要强制刷新时调用）
   */
  function clear() {
    summary.value = null
    lastFetchTime.value = 0
  }

  return {
    summary,
    lastFetchTime,
    loading,
    fetchDashboardSummary,
    getRecentInstances,
    clear,
  }
})
