import { onUnmounted } from 'vue'

interface PollingEntry {
  fn: () => void | Promise<void>
  ms: number
  id: ReturnType<typeof setInterval> | null
}

/**
 * 可见性感知轮询 composable
 *
 * - 标签页隐藏时自动暂停所有轮询（清除 interval，保留配置）
 * - 标签页重新可见时恢复轮询并立即执行一次
 * - 组件卸载时自动清理所有 interval 和事件监听
 *
 * 使用示例：
 * ```ts
 * const polling = usePollingWhenVisible()
 * polling.start('stats', loadStats, 5000)
 * polling.start('instance', loadInstance, 15000)
 * polling.stop('stats')
 * ```
 */
export function usePollingWhenVisible() {
  const entries = new Map<string, PollingEntry>()

  function startInterval(key: string): void {
    const entry = entries.get(key)
    if (!entry) return
    if (entry.id !== null) clearInterval(entry.id)
    entry.id = setInterval(entry.fn, entry.ms)
  }

  function stopInterval(key: string): void {
    const entry = entries.get(key)
    if (!entry || entry.id === null) return
    clearInterval(entry.id)
    entry.id = null
  }

  function start(key: string, fn: () => void | Promise<void>, ms: number): void {
    // 如果已存在同 key 的轮询，先停止旧的
    stopInterval(key)
    entries.set(key, { fn, ms, id: null })

    // 仅在页面可见时启动 interval（隐藏时等恢复后再启动）
    if (document.visibilityState === 'visible') {
      startInterval(key)
    }
  }

  function stop(key: string): void {
    stopInterval(key)
    entries.delete(key)
  }

  function stopAll(): void {
    for (const key of entries.keys()) {
      stopInterval(key)
    }
    entries.clear()
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      // 页面重新可见：恢复所有轮询并立即执行一次
      for (const [key, entry] of entries) {
        if (entry.id === null) {
          startInterval(key)
        }
        // 立即执行一次，确保数据最新
        entry.fn()
      }
    } else {
      // 页面隐藏：暂停所有轮询
      for (const key of entries.keys()) {
        stopInterval(key)
      }
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    stopAll()
  })

  return { start, stop, stopAll }
}
