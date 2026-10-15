<script setup lang="ts">
/**
 * TelegramBindCard —— 用户端 TGID 绑定卡片（重写版）
 *
 * 刻意做成「零依赖」：
 *   - 不走 @/api 客户端，直接用 fetch
 *   - 不走 vue-i18n，文案硬编码中文
 *   - 不走 toast store，用页面内提示
 * 目的是把之前排查过的所有嫌疑（api 客户端 / i18n / toast / 跨模块引用）一次排除掉。
 */
import { onMounted, ref } from 'vue'

const loading = ref(true)
const available = ref(false)
const bound = ref<any>(null)
const input = ref('')
const busy = ref(false)
const unbusy = ref(false)
const msg = ref('')
const msgType = ref<'ok' | 'err'>('ok')

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer ' + (localStorage.getItem('token') || ''), ...extra }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await fetch('/api/telegram/binding', { headers: authHeaders() })
    if (r.ok) {
      const j = await r.json()
      available.value = j?.tgidBindAvailable === true
      bound.value = j?.binding || null
    }
  } catch {
    // 网络异常：卡片显示「暂未启用」
  } finally {
    loading.value = false
  }
}

async function bind(): Promise<void> {
  const id = input.value.trim()
  if (!id) return
  busy.value = true
  msg.value = ''
  try {
    const r = await fetch('/api/telegram/bind-by-tgid', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tgUserId: id })
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      msgType.value = 'err'
      msg.value = j?.error || '绑定失败'
      return
    }
    msgType.value = 'ok'
    msg.value = '绑定成功'
    input.value = ''
    await load()
  } catch (e: any) {
    msgType.value = 'err'
    msg.value = String(e?.message || e)
  } finally {
    busy.value = false
  }
}

async function unbind(): Promise<void> {
  unbusy.value = true
  msg.value = ''
  try {
    const r = await fetch('/api/telegram/binding', { method: 'DELETE', headers: authHeaders() })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      msgType.value = 'err'
      msg.value = j?.error || '解绑失败'
      return
    }
    msgType.value = 'ok'
    msg.value = '已解绑'
    await load()
  } catch (e: any) {
    msgType.value = 'err'
    msg.value = String(e?.message || e)
  } finally {
    unbusy.value = false
  }
}

function displayName(): string {
  const b = bound.value
  if (!b) return ''
  if (b.telegramUsername) return '@' + b.telegramUsername
  const full = [b.firstName, b.lastName].filter(Boolean).join(' ')
  return full || 'ID ' + b.telegramUserId
}

onMounted(load)
</script>

<template>
  <div class="card p-5">
    <div class="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 class="text-sm font-medium text-themed-secondary">Telegram 绑定</h2>
        <p class="text-xs text-themed-faint mt-0.5">
          填写你的 Telegram 数字 ID，面板会校验你是否在群，并自动读取你的全名。
        </p>
      </div>
      <button class="btn-ghost btn-sm" :disabled="loading" @click="load">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="loading" class="p-4 bg-themed-tertiary border border-themed rounded-lg animate-pulse">
      <div class="h-4 bg-themed-secondary rounded w-1/3 mb-3"></div>
      <div class="h-3 bg-themed-secondary rounded w-2/3"></div>
    </div>

    <div v-else-if="!available" class="p-4 bg-themed-tertiary border border-themed rounded-lg">
      <div class="text-sm text-themed font-medium">暂未启用</div>
      <p class="text-xs text-themed-muted mt-1">管理员尚未开启 TGID 绑定。</p>
    </div>

    <div v-else-if="bound" class="p-4 bg-themed-tertiary border border-themed rounded-lg">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div class="text-sm text-themed font-medium">{{ displayName() }}</div>
          <p class="text-xs text-themed-muted mt-1">TGID：{{ bound.telegramUserId }}</p>
        </div>
        <button class="btn-ghost btn-sm text-error" :disabled="unbusy" @click="unbind">
          {{ unbusy ? '解绑中…' : '解绑' }}
        </button>
      </div>
    </div>

    <div v-else class="space-y-4">
      <div class="p-4 bg-themed-tertiary border border-themed rounded-lg">
        <div class="text-sm text-themed font-medium">填写 TGID 绑定</div>
        <p class="text-xs text-themed-muted mt-1">你必须是目标群成员，否则绑定会被拒绝。</p>
      </div>

      <div class="flex flex-col sm:flex-row gap-2">
        <input
          v-model="input"
          type="text"
          inputmode="numeric"
          class="input flex-1"
          placeholder="例如 123456789"
          :disabled="busy"
          @keyup.enter="bind"
        />
        <button class="btn-primary btn-sm" :disabled="busy || !input.trim()" @click="bind">
          {{ busy ? '绑定中…' : '立即绑定' }}
        </button>
      </div>

      <p v-if="!msg" class="text-xs text-themed-muted">一个 TGID 只能绑定一个面板账号。</p>
    </div>

    <!-- 提示信息：必须放在「已绑定/未绑定」两个分支之外，
         否则已绑定状态下点解绑失败（如 30 天冷却）时看不到任何反馈 -->
    <p v-if="msg" class="text-xs mt-2" :class="msgType === 'ok' ? 'text-green-500' : 'text-red-500'">{{ msg }}</p>
  </div>
</template>
