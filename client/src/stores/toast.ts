import { ref, type Ref } from 'vue'
import type { Toast } from '@/types/store.js'

const toasts: Ref<Toast[]> = ref([])
let nextId = 0

/**
 * 静默窗口：登出时置起，这段时间内不弹任何错误 toast。
 * 原因：登出后还有几个轮询请求在飞，它们必然 401，
 * 各页面 catch 里会统一 toast 一句「操作失败」，看起来像登出报错。
 */
let quietUntil = 0
export function silenceToastsFor(ms: number): void {
  quietUntil = Math.max(quietUntil, Date.now() + ms)
}

type ToastType = 'success' | 'error' | 'warning' | 'info'

export function useToast() {
  function show(message: string, type: ToastType = 'info', duration: number = 3000): number {
    // 静默窗口内不弹错误
    if (type === 'error' && Date.now() < quietUntil) return -1
    // 空消息不弹（登出后的静默失败用得上）
    if (!message || !String(message).trim()) return -1
    // 内部错误码（如 REFRESH_TOKEN_INVALID、UNAUTHORIZED）不外露给用户
    if (/^[A-Z][A-Z0-9_]{3,}$/.test(String(message).trim())) return -1
    const id = nextId++
    toasts.value.push({ id, message, type, duration, visible: true })
    
    if (duration > 0) {
      setTimeout(() => {
        remove(id)
      }, duration)
    }
    
    return id
  }

  function remove(id: number) {
    const index = toasts.value.findIndex(t => t.id === id)
    if (index > -1) {
      toasts.value[index].visible = false
      setTimeout(() => {
        toasts.value = toasts.value.filter(t => t.id !== id)
      }, 200)
    }
  }

  function success(message: string, duration?: number): number {
    return show(message, 'success', duration)
  }

  function error(message: string, duration?: number): number {
    return show(message, 'error', duration)
  }

  function warning(message: string, duration?: number): number {
    return show(message, 'warning', duration)
  }

  function info(message: string, duration?: number): number {
    return show(message, 'info', duration)
  }

  return {
    toasts,
    show,
    remove,
    success,
    error,
    warning,
    info
  }
}

