<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useThemeStore } from '@/stores/theme'
import { useToast } from '@/stores/toast'
import SkeletonLoader from '@/components/SkeletonLoader.vue'

interface PromoRecord {
  user?: { id: number; username: string; email: string; status: string } | null
  id: number
  code: string
  userId: number
  telegramUserId: string | null
  telegramUsername: string | null
  pointsCost: number
  itemName: string | null
  amount: number
  status: string
  scene: string | null
  sourceChatId: string | null
  reason: string | null
  usedAt: string | null
  usedInstanceId: number | null
  expiresAt: string
  createdAt: string
  ownerUsername?: string | null
  abnormal?: boolean
}

interface GuardLog {
  id: number
  runAt: string
  chatId: string | null
  source: string
  total: number
  inGroup: number
  leftGroup: number
  unbound: number
  failed: number
  durationMs: number
  error: string | null
}

interface Overview {
  promo: { total: number; active: number; used: number; expired: number; void: number; totalDiscount: number }
  guard: {
    logCount: number
    lastRunAt: string | null
    lastRun: { inGroup: number; leftGroup: number; unbound: number; failed: number; durationMs: number } | null
  }
  bindings: number
}

const props = withDefaults(defineProps<{
  embedded?: boolean
}>(), {
  embedded: false
})

const { t } = useI18n()
const toast = useToast()
const themeStore = useThemeStore()

type TabKey = 'records' | 'bindings' | 'guard' | 'settings'
const activeTab = ref<TabKey>('records')

// ==================== 绑定记录 ====================
interface BindingRow {
  id: number
  userId: number
  telegramUserId: string
  telegramUsername: string | null
  firstName: string | null
  lastName: string | null
  boundAt: string
  updatedAt: string
  user: { id: number; username: string; email: string; status: string } | null
}
const bindings = ref<BindingRow[]>([])
const bindingsTotal = ref(0)
const bindingsPage = ref(1)
const bindingsPageSize = 20
const bindingsKeyword = ref('')
const bindingsLoading = ref(false)
const bindingsLoaded = ref(false)

async function loadBindings(page = bindingsPage.value) {
  bindingsLoading.value = true
  try {
    const res = await api.admin.getBotBindings({
      page,
      pageSize: bindingsPageSize,
      keyword: bindingsKeyword.value.trim() || undefined
    })
    bindings.value = res.items
    bindingsTotal.value = res.total
    bindingsPage.value = res.page || page
  } catch (err: any) {
    toast.error(t('admin.botBridge.bindings.loadFailed') + ': ' + err.message)
  } finally {
    bindingsLoading.value = false
  }
}

function searchBindings() {
  loadBindings(1)
}

function resetBindingsSearch() {
  bindingsKeyword.value = ''
  loadBindings(1)
}

function bindingDisplayName(row: BindingRow): string {
  if (row.telegramUsername) return `@${row.telegramUsername}`
  const full = [row.firstName, row.lastName].filter(Boolean).join(' ')
  return full || `ID ${row.telegramUserId}`
}

// ==================== 概览 ====================
const overview = ref<Overview | null>(null)
const overviewLoading = ref(true)

async function loadOverview() {
  overviewLoading.value = true
  try {
    overview.value = await api.admin.getBotBridgeOverview()
  } catch (err: any) {
    toast.error(t('admin.botBridge.loadFailed') + ': ' + err.message)
  } finally {
    overviewLoading.value = false
  }
}

// ==================== 兑换记录 ====================
const records = ref<PromoRecord[]>([])
const recordsLoading = ref(false)
const recordsLoaded = ref(false)
const recordsPage = ref(1)
const recordsPageSize = ref(20)
const recordsTotal = ref(0)
const recordsTotalPages = ref(1)
const recordFilters = ref({ status: '', keyword: '', scene: '' })
const recordsPageSizeOptions = [20, 50, 100]

async function loadRecords() {
  recordsLoading.value = true
  try {
    const res = await api.admin.getBotBridgeRecords({
      page: recordsPage.value,
      pageSize: recordsPageSize.value,
      status: recordFilters.value.status || undefined,
      scene: recordFilters.value.scene || undefined,
      keyword: recordFilters.value.keyword.trim() || undefined
    })
    records.value = res.items
    recordsTotal.value = res.total
    recordsTotalPages.value = res.totalPages
    recordsLoaded.value = true
  } catch (err: any) {
    toast.error(t('admin.botBridge.loadFailed') + ': ' + err.message)
  } finally {
    recordsLoading.value = false
  }
}

function searchRecords() {
  recordsPage.value = 1
  loadRecords()
}

function resetRecordFilters() {
  recordFilters.value = { status: '', keyword: '', scene: '' }
  recordsPage.value = 1
  loadRecords()
}

// ==================== 守护日志 ====================
const guardLogs = ref<GuardLog[]>([])
const guardLoading = ref(false)
const guardLoaded = ref(false)
const guardPage = ref(1)
const guardPageSize = ref(20)
const guardTotal = ref(0)
const guardTotalPages = ref(1)
const guardPageSizeOptions = [20, 50, 100]

function copyChatId(id: string) {
  const done = () => toast.success('已复制群 ID：' + id)
  const failed = () => toast.error('复制失败，请手动选择复制')
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(id).then(done).catch(failed)
  } else {
    const ta = document.createElement('textarea')
    ta.value = id; document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy'); done() } catch { failed() }
    document.body.removeChild(ta)
  }
}

/** 批量把日志里的 chatId 换成群名（带缓存，失败静默） */
async function loadChatTitles(ids: string[]) {
  const todo = ids.filter((id) => id && !chatTitles.value[id])
  if (!todo.length) return
  await Promise.all(todo.map(async (id) => {
    try {
      const r = await fetch('/api/telegram/admin/chat-title?chatId=' + encodeURIComponent(id), {
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') }
      })
      if (!r.ok) return
      const d = await r.json()
      if (d?.title) { chatTitles.value = { ...chatTitles.value, [id]: d.title }; saveTitleCache() }
    } catch { /* 忽略 */ }
  }))
}

async function loadGuardLogs() {
  guardLoading.value = true
  try {
    const res = await api.admin.getBotBridgeGuardLogs({
      page: guardPage.value,
      pageSize: guardPageSize.value
    })
    guardLogs.value = res.items
    void loadChatTitles(Array.from(new Set((res.items || []).map((r: any) => String(r.chatId || '')).filter(Boolean))))
    guardTotal.value = res.total
    guardTotalPages.value = res.totalPages
    guardLoaded.value = true
  } catch (err: any) {
    toast.error(t('admin.botBridge.loadFailed') + ': ' + err.message)
  } finally {
    guardLoading.value = false
  }
}

// ==================== 设置 ====================
const settings = ref<{
  enabled: boolean
  source: 'db' | 'env' | 'none'
  token: string | null
  updatedAt: string | null
  guardEnabled: boolean
  guardIntervalMinutes: number
  expiryReminderDays: number
  expiryReminderEnabled: boolean
  tgBindEnabled: boolean
  tgBindGroupChatId: string
  tgBindHasToken: boolean
  tgBindAvailable: boolean
} | null>(null)
const settingsLoading = ref(false)
const settingsLoaded = ref(false)
const settingsSaving = ref(false)
const settingsTokenInput = ref('')
const showToken = ref(false)
// 守护同步（面板侧决定开关与周期，机器人读 /guard/meta 后照此执行）
const guardEnabled = ref(true)
const guardIntervalMinutes = ref(15)
// 守护周期支持「分钟 / 小时 / 天」三种单位，内部统一存分钟
const guardIntervalValue = ref(15)
const guardIntervalUnit = ref<'minute' | 'hour' | 'day'>('minute')
const GUARD_UNIT_MINUTES: Record<'minute' | 'hour' | 'day', number> = { minute: 1, hour: 60, day: 1440 }

/** 分钟 → 最易读的单位（能整除就升级单位） */
function applyGuardIntervalFromMinutes(total: number) {
  const m = Math.max(1, Math.floor(Number(total) || 15))
  guardIntervalMinutes.value = m
  if (m % 1440 === 0) {
    guardIntervalUnit.value = 'day'
    guardIntervalValue.value = m / 1440
  } else if (m % 60 === 0) {
    guardIntervalUnit.value = 'hour'
    guardIntervalValue.value = m / 60
  } else {
    guardIntervalUnit.value = 'minute'
    guardIntervalValue.value = m
  }
}

/** 当前「数值 + 单位」换算成分钟 */
function guardIntervalToMinutes(): number {
  const v = Math.max(1, Math.floor(Number(guardIntervalValue.value) || 1))
  return Math.min(43200, v * (GUARD_UNIT_MINUTES[guardIntervalUnit.value] || 1))
}
const expiryReminderDays = ref(5)
const expiryReminderEnabled = ref(true)
const savingExpiry = ref(false)
const savingGuard = ref(false)
const testingGuard = ref(false)
const guardTestResult = ref<Awaited<ReturnType<typeof api.admin.testBotGuard>> | null>(null)

async function testGuard() {
  testingGuard.value = true
  try {
    guardTestResult.value = await api.admin.testBotGuard()
    const v = guardTestResult.value.verdict
    if (v === 'ok') toast.success(t('admin.botBridge.settings.guardTestOk'))
    else toast.error(t(`admin.botBridge.settings.guardTestVerdict.${v}`))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.guardTestFailed') + ': ' + (err?.response?.data?.message || err.message))
  } finally {
    testingGuard.value = false
  }
}

// 守护日志详情弹窗
const guardDetailOpen = ref(false)
const guardDetailLoading = ref(false)
const guardDetail = ref<Awaited<ReturnType<typeof api.admin.getBotGuardLogDetail>> | null>(null)
const guardDetailTab = ref<'normal' | 'abnormal'>('normal')
const chatTitle = ref('')
const CHAT_TITLE_CACHE_KEY = 'incudal_chat_titles'
function readTitleCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CHAT_TITLE_CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch { return {} }
}
const chatTitles = ref<Record<string, string>>(readTitleCache())
function saveTitleCache() {
  try { localStorage.setItem(CHAT_TITLE_CACHE_KEY, JSON.stringify(chatTitles.value)) } catch { /* 忽略 */ }
}

async function openGuardDetail(id: number) {
  guardDetailOpen.value = true
  guardDetailLoading.value = true
  guardDetail.value = null
  guardDetailTab.value = 'normal'
  chatTitle.value = ''
  try {
    guardDetail.value = await api.admin.getBotGuardLogDetail(id)
    // 把 -100xxxx 换成群名（失败就还是显示 ID）
    const cid = String((guardDetail.value as any)?.chatId || '').trim()
    if (cid) {
      // 先用本地缓存立即显示群名，避免「先闪一下 ID 再变名字」
      const cached = chatTitles.value[cid]
      if (cached) chatTitle.value = cached
      fetch('/api/telegram/admin/chat-title?chatId=' + encodeURIComponent(cid), {
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') }
      })
        .then((r) => (r.ok ? r.json() : { title: '' }))
        .then((r: any) => {
          if (r?.title) {
            chatTitle.value = r.title
            chatTitles.value = { ...chatTitles.value, [cid]: r.title }
            saveTitleCache()
          }
        })
        .catch(() => {})
    }
  } catch (err: any) {
    toast.error(err?.response?.data?.message || err.message)
    guardDetailOpen.value = false
  } finally {
    guardDetailLoading.value = false
  }
}

/** 群内权限 → 文案（creator/administrator/member/restricted/left/kicked/...） */
function roleLabel(s: string): string {
  const map: Record<string, string> = {
    creator: '群主', administrator: '管理员', member: '成员',
    restricted: '受限成员', left: '已退群', kicked: '已被踢出',
    request_failed: '查询失败', not_bound: '未绑定',
  }
  return map[s] || s || '未知'
}

const guardDetailNormal = computed(() =>
  (guardDetail.value?.details || []).filter((d) => d.member && d.statusText !== 'request_failed')
)
const guardDetailAbnormal = computed(() =>
  (guardDetail.value?.details || []).filter((d) => !d.member || d.statusText === 'request_failed')
)

function fmtAgo(ms: number | null): string {
  if (ms == null) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
// TGID 绑定（独立于「TG 设置」卡片；只用 getChatMember，不涉及 webhook）
const tgBindEnabled = ref(false)
const tgBindGroupChatId = ref('')
const tgBindBotTokenInput = ref('')
const savingTgBind = ref(false)

async function loadSettings() {
  settingsLoading.value = true
  try {
    settings.value = await api.admin.getBotBridgeSettings()
    guardEnabled.value = settings.value.guardEnabled !== false
    applyGuardIntervalFromMinutes(Number(settings.value.guardIntervalMinutes || 15))
    expiryReminderDays.value = Number(settings.value.expiryReminderDays ?? 5)
    expiryReminderEnabled.value = settings.value.expiryReminderEnabled !== false
    tgBindEnabled.value = settings.value.tgBindEnabled === true
    tgBindGroupChatId.value = String(settings.value.tgBindGroupChatId || '')
    tgBindBotTokenInput.value = ''
  } catch (err: any) {
    toast.error(t('admin.botBridge.loadFailed') + ': ' + err.message)
  } finally {
    settingsLoading.value = false
    settingsLoaded.value = true
  }
}

// 保存守护开关与周期（只发这两个字段，不动密钥）
async function saveGuardSettings() {
  savingGuard.value = true
  try {
    // 只发守护自己的字段：到期提醒有独立开关和独立保存按钮，互不干扰
    settings.value = await api.admin.updateBotBridgeSettings({
      guardEnabled: guardEnabled.value === true,
      guardIntervalMinutes: guardIntervalToMinutes()
    })
    guardEnabled.value = settings.value.guardEnabled !== false
    applyGuardIntervalFromMinutes(Number(settings.value.guardIntervalMinutes || 15))
    toast.success(t('admin.botBridge.settings.guardSaved'))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.saveFailed') + ': ' + err.message)
  } finally {
    savingGuard.value = false
  }
}

// 保存「到期提醒」设置（独立开关 + 天数）——只发这两个字段，
// 不动守护开关/周期，提示也是自己的文案，不跟守护混在一起。
async function saveExpirySettings() {
  savingExpiry.value = true
  try {
    settings.value = await api.admin.updateBotBridgeSettings({
      expiryReminderEnabled: expiryReminderEnabled.value === true,
      expiryReminderDays: Math.min(90, Math.max(0, Math.floor(Number(expiryReminderDays.value) || 0)))
    })
    expiryReminderEnabled.value = settings.value.expiryReminderEnabled !== false
    expiryReminderDays.value = Number(settings.value.expiryReminderDays ?? 5)
    toast.success(t('admin.botBridge.settings.expirySaved'))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.saveFailed') + ': ' + err.message)
  } finally {
    savingExpiry.value = false
  }
}

// 保存 TGID 绑定设置（Bot Token 留空 = 不改；填了就覆盖）
async function saveTgBindSettings() {
  savingTgBind.value = true
  try {
    const payload: Record<string, unknown> = {
      tgBindEnabled: tgBindEnabled.value === true,
      tgBindGroupChatId: tgBindGroupChatId.value.trim()
    }
    if (tgBindBotTokenInput.value.trim()) {
      payload.tgBindBotToken = tgBindBotTokenInput.value.trim()
    }
    settings.value = await api.admin.updateBotBridgeSettings(payload as any)
    tgBindEnabled.value = settings.value.tgBindEnabled === true
    tgBindGroupChatId.value = String(settings.value.tgBindGroupChatId || '')
    tgBindBotTokenInput.value = ''
    toast.success(t('admin.botBridge.settings.tgBindSaved'))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.saveFailed') + ': ' + err.message)
  } finally {
    savingTgBind.value = false
  }
}

async function saveSettingsToken() {
  const token = settingsTokenInput.value.trim()
  if (token.length < 16) {
    toast.warning(t('admin.botBridge.settings.tokenTooShort'))
    return
  }

  settingsSaving.value = true
  try {
    settings.value = await api.admin.updateBotBridgeSettings({ token })
    settingsTokenInput.value = ''
    showToken.value = true
    toast.success(t('admin.botBridge.settings.saved'))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.saveFailed') + ': ' + err.message)
  } finally {
    settingsSaving.value = false
  }
}

async function generateSettingsToken() {
  if (!window.confirm(t('admin.botBridge.settings.generateConfirm'))) return

  settingsSaving.value = true
  try {
    settings.value = await api.admin.updateBotBridgeSettings({ generate: true })
    settingsTokenInput.value = ''
    showToken.value = true
    toast.success(t('admin.botBridge.settings.generated'))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.saveFailed') + ': ' + err.message)
  } finally {
    settingsSaving.value = false
  }
}

async function disableSettings() {
  if (!window.confirm(t('admin.botBridge.settings.disableConfirm'))) return

  settingsSaving.value = true
  try {
    settings.value = await api.admin.disableBotBridge()
    showToken.value = false
    toast.success(t('admin.botBridge.settings.disabled'))
  } catch (err: any) {
    toast.error(t('admin.botBridge.settings.saveFailed') + ': ' + err.message)
  } finally {
    settingsSaving.value = false
  }
}

function sourceLabel(source: 'db' | 'env' | 'none'): string {
  if (source === 'db') return t('admin.botBridge.settings.sourceDb')
  if (source === 'env') return t('admin.botBridge.settings.sourceEnv')
  return t('admin.botBridge.settings.sourceNone')
}

/** 给机器人填的「自定义接口地址」。 */
const botApiUrl = computed(() => {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/api/bot`
})

// ==================== 工具 ====================
function switchTab(tab: TabKey) {
  activeTab.value = tab
  if (tab === 'records' && !recordsLoaded.value) loadRecords()
  if (tab === 'bindings' && !bindingsLoaded.value) {
    bindingsLoaded.value = true
    loadBindings(1)
  }
  if (tab === 'guard' && !guardLoaded.value) loadGuardLogs()
  if (tab === 'settings' && !settingsLoaded.value) loadSettings()
}

function formatMoney(amount: number): string {
  return `¥${Number(amount || 0).toFixed(2)}`
}

function formatDate(value: string | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function statusClass(status: string): string {
  if (status === 'used') return 'badge-default'
  if (status === 'expired') return 'badge-error'
  if (status === 'void') return 'badge-error'
  return 'badge-success'
}

function statusLabel(status: string): string {
  if (status === 'used') return t('admin.botBridge.records.statusUsed')
  if (status === 'expired') return t('admin.botBridge.records.statusExpired')
  if (status === 'void') return t('admin.botBridge.records.statusVoid')
  return t('admin.botBridge.records.statusActive')
}

const voidingCode = ref('')

async function voidRecord(code: string) {
  if (!window.confirm(t('admin.botBridge.records.voidConfirm', { code }))) return
  voidingCode.value = code
  try {
    await api.admin.voidBotPromo(code)
    toast.success(t('admin.botBridge.records.voidOk'))
    await loadRecords()
  } catch (e: any) {
    toast.error(e?.response?.data?.message || e?.message || t('common.failed'))
  } finally {
    voidingCode.value = ''
  }
}

async function restoreRecord(code: string) {
  voidingCode.value = code
  try {
    await api.admin.restoreBotPromo(code)
    toast.success(t('admin.botBridge.records.restoreOk'))
    await loadRecords()
  } catch (e: any) {
    toast.error(e?.response?.data?.message || e?.message || t('common.failed'))
  } finally {
    voidingCode.value = ''
  }
}

function copyText(value: string) {
  if (!value) return
  navigator.clipboard?.writeText(value).then(
    () => toast.success(t('common.copied')),
    () => toast.error(t('common.copyFailed'))
  )
}

const recordStatusOptions = computed(() => ['active', 'used', 'void', 'expired'])

onMounted(() => {
  loadOverview()
  loadRecords()
})
</script>

<template>
  <div :class="['animate-fade-in', props.embedded ? 'space-y-4' : 'space-y-6']">
    <div class="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="page-title">{{ $t('admin.botBridge.title') }}</h1>
        <p class="text-sm text-themed-muted mt-1" v-html="$t('admin.botBridge.description')"></p>
      </div>
      <button class="btn btn-ghost" :disabled="overviewLoading" @click="loadOverview">
        {{ overviewLoading ? $t('common.processing') : $t('common.refresh') }}
      </button>
    </div>

    <!-- 概览卡片 -->
    <div v-if="overview" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="card p-4">
        <div class="text-xs text-themed-muted">{{ $t('admin.botBridge.overview.promoTotal') }}</div>
        <div class="mt-1 text-2xl font-semibold text-themed">{{ overview.promo.total }}</div>
        <div class="mt-1 text-xs text-themed-muted">
          {{ $t('admin.botBridge.overview.promoActive') }} {{ overview.promo.active }} ·
          {{ $t('admin.botBridge.overview.promoUsed') }} {{ overview.promo.used }} ·
          {{ $t('admin.botBridge.overview.promoExpired') }} {{ overview.promo.expired }}
          · {{ $t('admin.botBridge.overview.promoVoid') }} {{ overview.promo.void }}
        </div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-themed-muted">{{ $t('admin.botBridge.overview.promoDiscount') }}</div>
        <div class="mt-1 text-2xl font-semibold text-themed">{{ formatMoney(overview.promo.totalDiscount) }}</div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-themed-muted">{{ $t('admin.botBridge.overview.guardLogs') }}</div>
        <div class="mt-1 text-2xl font-semibold text-themed">{{ overview.guard.logCount }}</div>
        <div class="mt-1 text-xs text-themed-muted">
          {{ $t('admin.botBridge.overview.lastRun') }}: {{ formatDate(overview.guard.lastRunAt) }}
        </div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-themed-muted">{{ $t('admin.botBridge.overview.bindings') }}</div>
        <div class="mt-1 text-2xl font-semibold text-themed">{{ overview.bindings }}</div>
      </div>
    </div>
    <SkeletonLoader v-else-if="overviewLoading" :count="1" />

    <!-- Tab 切换 -->
    <div class="border-b border-themed overflow-x-auto">
      <nav class="flex flex-nowrap gap-3 sm:gap-4 md:gap-6 min-w-max">
        <button
          :class="[
            'pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0',
            activeTab === 'records'
              ? (themeStore.isDark ? 'border-white text-white' : 'border-gray-900 text-gray-900')
              : 'border-transparent text-themed-muted hover:text-themed-secondary'
          ]"
          @click="switchTab('records')"
        >
          {{ $t('admin.botBridge.tabs.records') }}
        </button>
        <button
          :class="[
            'pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0',
            activeTab === 'bindings'
              ? (themeStore.isDark ? 'border-white text-white' : 'border-gray-900 text-gray-900')
              : 'border-transparent text-themed-muted hover:text-themed-secondary'
          ]"
          @click="switchTab('bindings')"
        >
          {{ $t('admin.botBridge.tabs.bindings') }}
        </button>
        <button
          :class="[
            'pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0',
            activeTab === 'guard'
              ? (themeStore.isDark ? 'border-white text-white' : 'border-gray-900 text-gray-900')
              : 'border-transparent text-themed-muted hover:text-themed-secondary'
          ]"
          @click="switchTab('guard')"
        >
          {{ $t('admin.botBridge.tabs.guard') }}
        </button>
        <button
          :class="[
            'pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex-shrink-0',
            activeTab === 'settings'
              ? (themeStore.isDark ? 'border-white text-white' : 'border-gray-900 text-gray-900')
              : 'border-transparent text-themed-muted hover:text-themed-secondary'
          ]"
          @click="switchTab('settings')"
        >
          {{ $t('admin.botBridge.tabs.settings') }}
        </button>
      </nav>
    </div>

    <!-- ==================== 兑换记录 ==================== -->
    <!-- 绑定记录 -->
    <div v-if="activeTab === 'bindings'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="bindingsKeyword"
          type="text"
          class="input flex-1 min-w-[200px]"
          :placeholder="$t('admin.botBridge.bindings.searchPlaceholder')"
          @keyup.enter="searchBindings"
        />
        <button class="btn-primary btn-sm" :disabled="bindingsLoading" @click="searchBindings">
          {{ $t('admin.botBridge.bindings.search') }}
        </button>
        <button class="btn-ghost btn-sm" :disabled="bindingsLoading" @click="resetBindingsSearch">
          {{ $t('admin.botBridge.bindings.reset') }}
        </button>
      </div>

      <div class="text-xs text-themed-muted">
        {{ $t('admin.botBridge.bindings.total', { n: bindingsTotal }) }}
      </div>

      <div v-if="bindingsLoading" class="p-4 text-sm text-themed-muted">
        {{ $t('common.loading') }}
      </div>

      <div v-else-if="!bindings.length" class="p-6 text-center text-sm text-themed-muted">
        {{ $t('admin.botBridge.bindings.empty') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-themed-muted border-b border-themed">
              <th class="py-2 pr-4">{{ $t('admin.botBridge.bindings.colTg') }}</th>
              <th class="py-2 pr-4">TGID</th>
              <th class="py-2 pr-4">{{ $t('admin.botBridge.bindings.colAccount') }}</th>
              <th class="py-2 pr-4">{{ $t('admin.botBridge.bindings.colEmail') }}</th>
              <th class="py-2 pr-4">{{ $t('admin.botBridge.bindings.colBoundAt') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in bindings" :key="row.id" class="border-b border-themed/50">
              <td class="py-2 pr-4 text-themed">{{ bindingDisplayName(row) }}</td>
              <td class="py-2 pr-4">
                <code class="px-1 py-0.5 rounded bg-themed-secondary text-xs">{{ row.telegramUserId }}</code>
              </td>
              <td class="py-2 pr-4 text-themed">{{ row.user?.username || `#${row.userId}` }}</td>
              <td class="py-2 pr-4 text-xs text-themed-muted">{{ row.user?.email || '-' }}</td>
              <td class="py-2 pr-4 text-xs text-themed-muted">{{ formatDate(row.boundAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="bindingsTotal > bindingsPageSize" class="flex items-center justify-center gap-2">
        <button
          class="btn-ghost btn-sm"
          :disabled="bindingsPage <= 1 || bindingsLoading"
          @click="loadBindings(bindingsPage - 1)"
        >
          {{ $t('admin.botBridge.bindings.prev') }}
        </button>
        <span class="text-xs text-themed-muted">{{ bindingsPage }} / {{ Math.ceil(bindingsTotal / bindingsPageSize) }}</span>
        <button
          class="btn-ghost btn-sm"
          :disabled="bindingsPage >= Math.ceil(bindingsTotal / bindingsPageSize) || bindingsLoading"
          @click="loadBindings(bindingsPage + 1)"
        >
          {{ $t('common.next') }}
        </button>
      </div>
    </div>

    <div v-if="activeTab === 'records'" class="space-y-4">
      <div class="card p-4 md:p-5">
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <input
            v-model="recordFilters.keyword"
            class="input w-full"
            :placeholder="$t('admin.botBridge.records.searchPlaceholder')"
            @keyup.enter="searchRecords"
          />
          <select v-model="recordFilters.status" class="input w-full" @change="searchRecords">
            <option value="">{{ $t('admin.botBridge.records.allStatus') }}</option>
            <option v-for="s in recordStatusOptions" :key="s" :value="s">{{ statusLabel(s) }}</option>
          </select>
          <select v-model="recordFilters.scene" class="input w-full" @change="searchRecords">
            <option value="">{{ $t('admin.botBridge.records.allScene') }}</option>
            <option value="purchase">{{ $t('admin.botBridge.records.scenePurchase') }}</option>
            <option value="renew">{{ $t('admin.botBridge.records.sceneRenew') }}</option>
          </select>
        </div>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm text-themed-muted">{{ $t('admin.botBridge.totalCount', { count: recordsTotal }) }}</div>
          <div class="flex gap-2">
            <button class="btn btn-ghost btn-sm" @click="resetRecordFilters">{{ $t('common.reset') }}</button>
            <button class="btn btn-primary btn-sm" @click="searchRecords">{{ $t('common.search') }}</button>
          </div>
        </div>
      </div>

      <SkeletonLoader v-if="recordsLoading" :count="5" />

      <div v-else-if="records.length > 0" class="card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[1080px] text-xs">
            <thead class="bg-themed-secondary/80">
              <tr>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.code') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.user') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.telegram') }}</th>
                <th class="p-3 text-left whitespace-nowrap">TGID</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.type') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.item') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.points') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.status') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.createdAt') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.usedAt') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.records.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in records" :key="row.id" class="border-t border-themed hover:bg-themed-secondary/40">
                <td class="p-3 font-mono text-xs whitespace-nowrap">
                  <button class="hover:text-blue-500" @click="copyText(row.code)">{{ row.code }}</button>
                </td>
                <td class="p-3 whitespace-nowrap">{{ row.user?.username || `#${row.userId}` }}</td>
                <td class="p-3 whitespace-nowrap">
                  <div
                    class="max-w-[120px] truncate"
                    :title="row.telegramUsername ? '@' + row.telegramUsername : (row.telegramUserId || '')"
                  >
                    <span v-if="row.telegramUsername">@{{ row.telegramUsername }}</span>
                    <span v-else-if="row.telegramUserId" class="font-mono text-xs">{{ row.telegramUserId }}</span>
                    <span v-else class="text-themed-muted">-</span>
                  </div>
                </td>
                <td class="p-3 whitespace-nowrap">
                  <span v-if="row.telegramUserId" class="font-mono text-xs">{{ row.telegramUserId }}</span>
                  <span v-else class="text-themed-muted">-</span>
                </td>
                <td class="p-3 whitespace-nowrap">
                  <span :class="['badge', row.scene === 'renew' ? 'badge-warning' : 'badge-default']">
                    {{ row.scene === 'renew' ? $t('admin.botBridge.records.sceneRenew') : $t('admin.botBridge.records.scenePurchase') }}
                  </span>
                </td>
                <td class="p-3 whitespace-nowrap">{{ row.itemName || '-' }}</td>
                <td class="p-3 whitespace-nowrap">{{ row.pointsCost }}</td>
                <td class="p-3 whitespace-nowrap">
                  <span
                    v-if="row.abnormal"
                    class="badge bg-red-500/15 text-red-500"
                    :title="$t('admin.discount.abnormalRecordHint')"
                  >{{ $t('admin.discount.abnormalRecord') }}</span>
                  <span v-else :class="['badge', statusClass(row.status)]">{{ statusLabel(row.status) }}</span>
                </td>
                <td class="p-3 whitespace-nowrap text-xs text-themed-muted">{{ formatDate(row.createdAt) }}</td>
                <td class="p-3 whitespace-nowrap text-xs text-themed-muted">
                  {{ formatDate(row.usedAt) }}
                </td>
                <td class="p-3 whitespace-nowrap">
                  <button
                    v-if="row.status === 'active'"
                    class="btn btn-sm border-red-500 bg-red-500 text-white hover:bg-red-600"
                    :disabled="voidingCode === row.code"
                    @click="voidRecord(row.code)"
                  >{{ voidingCode === row.code ? $t('common.processing') : $t('admin.botBridge.records.void') }}</button>
                  <button
                    v-else-if="row.status === 'void'"
                    class="btn btn-sm btn-ghost"
                    :disabled="voidingCode === row.code"
                    @click="restoreRecord(row.code)"
                  >{{ $t('admin.botBridge.records.restore') }}</button>
                  <span v-else class="text-themed-muted">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else class="card p-10 text-center">
        <div class="text-base font-medium text-themed">{{ $t('admin.botBridge.records.empty') }}</div>
      </div>

      <div v-if="records.length > 0" class="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-2 text-sm text-themed-muted">
          <span>{{ $t('admin.botBridge.perPage') }}</span>
          <select
            :value="recordsPageSize"
            class="input w-20 py-1"
            @change="recordsPageSize = Number(($event.target as HTMLSelectElement).value); recordsPage = 1; loadRecords()"
          >
            <option v-for="size in recordsPageSizeOptions" :key="size" :value="size">{{ size }}</option>
          </select>
          <span>{{ $t('admin.botBridge.totalCount', { count: recordsTotal }) }}</span>
        </div>
        <div v-if="recordsTotalPages > 1" class="flex items-center gap-2">
          <button class="btn btn-sm btn-ghost" :disabled="recordsPage <= 1" @click="recordsPage--; loadRecords()">{{ $t('common.prevPage') }}</button>
          <span class="text-sm text-themed-muted">{{ recordsPage }} / {{ recordsTotalPages }}</span>
          <button class="btn btn-sm btn-ghost" :disabled="recordsPage >= recordsTotalPages" @click="recordsPage++; loadRecords()">{{ $t('common.nextPage') }}</button>
        </div>
      </div>
    </div>

    <!-- ==================== 守护日志 ==================== -->
    <div v-if="activeTab === 'guard'" class="space-y-4">
      <SkeletonLoader v-if="guardLoading" :count="5" />

      <div v-else-if="guardLogs.length > 0" class="card overflow-hidden">
        <div class="max-h-[60vh] overflow-y-auto overflow-x-auto">
          <table class="w-full min-w-[980px] text-sm">
            <thead class="sticky top-0 z-10 bg-themed-secondary/80 backdrop-blur">
              <tr>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.runAt') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.source') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.chatId') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.total') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.inGroup') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.leftGroup') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.unbound') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.failed') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.duration') }}</th>
                <th class="p-3 text-left whitespace-nowrap">{{ $t('admin.botBridge.guard.error') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in guardLogs"
                :key="row.id"
                class="border-t border-themed hover:bg-themed-secondary/40"
              >
                <td
                  class="p-3 whitespace-nowrap text-themed-muted cursor-pointer hover:text-blue-500 hover:underline"
                  title="点击查看巡检详情"
                  @click="openGuardDetail(row.id)"
                >{{ formatDate(row.runAt) }}</td>
                <td class="p-3 whitespace-nowrap">
                  <span class="badge badge-default">{{ row.source }}</span>
                </td>
                <td class="p-3 whitespace-nowrap text-xs">
                  <span
                    v-if="row.chatId"
                    class="cursor-pointer hover:text-blue-500 hover:underline"
                    :title="'点击复制 ' + row.chatId"
                    @click="copyChatId(row.chatId)"
                  >{{ chatTitles[row.chatId] || row.chatId }}</span>
                  <span v-else>-</span>
                </td>
                <td class="p-3 whitespace-nowrap">{{ row.total }}</td>
                <td class="p-3 whitespace-nowrap text-green-500">{{ row.inGroup }}</td>
                <td class="p-3 whitespace-nowrap text-red-500">{{ row.leftGroup }}</td>
                <td class="p-3 whitespace-nowrap">{{ row.unbound }}</td>
                <td class="p-3 whitespace-nowrap" :class="row.failed > 0 ? 'text-red-500' : ''">{{ row.failed }}</td>
                <td class="p-3 whitespace-nowrap text-themed-muted">{{ row.durationMs }} ms</td>
                <td class="p-3 whitespace-nowrap text-red-500 max-w-[240px] truncate" :title="row.error || ''">{{ row.error || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else class="card p-10 text-center">
        <div class="text-base font-medium text-themed">{{ $t('admin.botBridge.guard.empty') }}</div>
      </div>

      <div v-if="guardLogs.length > 0" class="card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-2 text-sm text-themed-muted">
          <span>{{ $t('admin.botBridge.perPage') }}</span>
          <select
            :value="guardPageSize"
            class="input w-20 py-1"
            @change="guardPageSize = Number(($event.target as HTMLSelectElement).value); guardPage = 1; loadGuardLogs()"
          >
            <option v-for="size in guardPageSizeOptions" :key="size" :value="size">{{ size }}</option>
          </select>
          <span>{{ $t('admin.botBridge.totalCount', { count: guardTotal }) }}</span>
        </div>
        <div v-if="guardTotalPages > 1" class="flex items-center gap-2">
          <button class="btn btn-sm btn-ghost" :disabled="guardPage <= 1" @click="guardPage--; loadGuardLogs()">{{ $t('common.prevPage') }}</button>
          <span class="text-sm text-themed-muted">{{ guardPage }} / {{ guardTotalPages }}</span>
          <button class="btn btn-sm btn-ghost" :disabled="guardPage >= guardTotalPages" @click="guardPage++; loadGuardLogs()">{{ $t('common.nextPage') }}</button>
        </div>
      </div>
    </div>


    <!-- ==================== 设置 ==================== -->
    <div v-if="activeTab === 'settings'" class="space-y-4">
      <SkeletonLoader v-if="settingsLoading && !settings" :count="2" />

      <template v-else>
        <div class="card p-4 md:p-5 space-y-4">
          <div>
            <h3 class="text-base font-medium text-themed">{{ $t('admin.botBridge.settings.title') }}</h3>
            <p class="mt-1 text-sm text-themed-muted">{{ $t('admin.botBridge.settings.description') }}</p>
          </div>

          <!-- 状态 -->
          <div class="flex flex-wrap items-center gap-3">
            <span :class="['badge', settings?.enabled ? 'badge-success' : 'badge-default']">
              {{ settings?.enabled ? $t('admin.botBridge.settings.enabled') : $t('admin.botBridge.settings.disabledState') }}
            </span>
            <span class="text-sm text-themed-muted">
              {{ $t('admin.botBridge.settings.source') }}: {{ settings ? sourceLabel(settings.source) : '-' }}
            </span>
            <span v-if="settings?.updatedAt" class="text-sm text-themed-muted">
              {{ $t('admin.botBridge.settings.updatedAt') }}: {{ formatDate(settings.updatedAt) }}
            </span>
          </div>

          <p v-if="settings?.source === 'env'" class="text-xs text-amber-500">
            {{ $t('admin.botBridge.settings.envNote') }}
          </p>

          <!-- 对接机器人：自定义接口地址 + 密令 -->
          <div class="rounded border border-themed bg-themed-secondary/30 p-3 space-y-3">
            <div class="text-xs font-medium text-themed">{{ $t('admin.botBridge.settings.botConfigTitle') }}</div>

            <div class="space-y-1">
              <div class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.botApiUrl') }}</div>
              <div class="flex flex-wrap items-center gap-2">
                <code class="flex-1 min-w-[240px] rounded border border-themed bg-themed-secondary/40 px-3 py-2 font-mono text-xs break-all">{{ botApiUrl }}</code>
                <button class="btn btn-ghost btn-sm" @click="copyText(botApiUrl)">{{ $t('common.copy') }}</button>
              </div>
            </div>

            <div class="space-y-1">
              <div class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.botSecret') }}</div>
              <div v-if="settings?.token" class="flex flex-wrap items-center gap-2">
                <code class="flex-1 min-w-[240px] rounded border border-themed bg-themed-secondary/40 px-3 py-2 font-mono text-xs break-all">
                  {{ showToken ? settings?.token : '••••••••••••••••••••••••' }}
                </code>
                <button class="btn btn-ghost btn-sm" @click="showToken = !showToken">
                  {{ showToken ? $t('admin.botBridge.settings.hide') : $t('admin.botBridge.settings.show') }}
                </button>
                <button class="btn btn-ghost btn-sm" @click="copyText(settings?.token || '')">{{ $t('common.copy') }}</button>
              </div>
              <div v-else class="text-sm text-themed-muted">{{ $t('admin.botBridge.settings.noToken') }}</div>
            </div>

            <p class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.botAuthNote') }}</p>
          </div>

          <!-- 守护同步：不在群成员巡检（面板决定开关与周期，机器人读取后执行） -->
          <div class="rounded border border-themed bg-themed-secondary/30 p-3 space-y-3">
            <div class="text-xs font-medium text-themed">{{ $t('admin.botBridge.settings.guardTitle') }}</div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-2">
                <label class="label">{{ $t('admin.botBridge.settings.guardEnabled') }}</label>
                <select v-model="guardEnabled" class="input">
                  <option :value="true">{{ $t('admin.botBridge.settings.guardOn') }}</option>
                  <option :value="false">{{ $t('admin.botBridge.settings.guardOff') }}</option>
                </select>
              </div>
              <div class="space-y-2">
                <label class="label">{{ $t('admin.botBridge.settings.guardInterval') }}</label>
                <div class="flex gap-2">
                  <input
                    v-model.number="guardIntervalValue"
                    type="number"
                    min="1"
                    max="43200"
                    class="input flex-1"
                  />
                  <select v-model="guardIntervalUnit" class="input w-24">
                    <option value="minute">{{ $t('admin.botBridge.settings.guardUnitMinute') }}</option>
                    <option value="hour">{{ $t('admin.botBridge.settings.guardUnitHour') }}</option>
                    <option value="day">{{ $t('admin.botBridge.settings.guardUnitDay') }}</option>
                  </select>
                </div>
              </div>
            </div>
            <p class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.guardNote') }}</p>
            <div class="flex flex-wrap justify-end gap-2">
              <button class="btn btn-ghost btn-sm" :disabled="testingGuard" @click="testGuard">
                {{ testingGuard ? $t('admin.botBridge.settings.guardTesting') : $t('admin.botBridge.settings.guardTest') }}
              </button>
              <button class="btn btn-primary btn-sm" :disabled="savingGuard" @click="saveGuardSettings">
                {{ savingGuard ? $t('common.saving') : $t('common.save') }}
              </button>
            </div>

            <!-- 守护诊断结果 -->
            <div v-if="guardTestResult" class="rounded border border-themed bg-themed-secondary/40 p-3 space-y-2 text-xs">
              <div class="flex items-center gap-2">
                <span
                  class="badge"
                  :class="guardTestResult.verdict === 'ok' ? 'badge-success' : 'badge-error'"
                >{{ $t(`admin.botBridge.settings.guardTestVerdict.${guardTestResult.verdict}`) }}</span>
                <span class="text-themed-muted">{{ fmtAgo(guardTestResult?.lastRunAgoMs) }}</span>
              </div>
              <div class="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                <div>{{ $t('admin.botBridge.settings.guardTestEnabled') }}: <b>{{ guardTestResult?.guardEnabled ? $t('admin.botBridge.settings.guardOn') : $t('admin.botBridge.settings.guardOff') }}</b></div>
                <div>{{ $t('admin.botBridge.settings.guardTestInterval') }}: <b>{{ guardTestResult?.intervalMinutes }} {{ $t('admin.botBridge.settings.guardUnitMinute') }}</b></div>
                <div>{{ $t('admin.botBridge.settings.guardTestBound') }}: <b>{{ guardTestResult?.boundUsers }}</b></div>
                <div>{{ $t('admin.botBridge.settings.guardTestInstances') }}: <b>{{ guardTestResult?.instanceCount }}</b></div>
                <div v-if="guardTestResult.lastRun">
                  {{ $t('admin.botBridge.settings.guardTestTotal') }}: <b>{{ guardTestResult.lastRun?.total }}</b>
                </div>
                <div v-if="guardTestResult.lastRun">
                  {{ $t('admin.botBridge.settings.guardTestInGroup') }}: <b class="text-green-500">{{ guardTestResult.lastRun?.inGroup }}</b>
                </div>
                <div v-if="guardTestResult.lastRun">
                  {{ $t('admin.botBridge.settings.guardTestLeftGroup') }}: <b :class="guardTestResult.lastRun?.leftGroup > 0 ? 'text-red-500' : ''">{{ guardTestResult.lastRun?.leftGroup }}</b>
                </div>
                <div v-if="guardTestResult.lastRun">
                  {{ $t('admin.botBridge.settings.guardTestFailed') }}: <b :class="guardTestResult.lastRun?.failed > 0 ? 'text-red-500' : ''">{{ guardTestResult.lastRun?.failed }}</b>
                </div>
                <div v-if="guardTestResult.lastRun">
                  {{ $t('admin.botBridge.settings.guardTestLastAt') }}: <b>{{ formatDate(guardTestResult.lastRun?.runAt) }}</b>
                </div>
              </div>
              <div v-if="guardTestResult.hints?.length" class="space-y-1 border-t border-themed pt-2">
                <div v-for="(h, i) in (guardTestResult.hints || [])" :key="i" class="text-amber-500">⚠ {{ h }}</div>
              </div>
            </div>
          </div>

          <!-- 到期提醒（**独立于守护同步**：有自己的开关，互不影响） -->
          <div class="rounded border border-themed bg-themed-secondary/30 p-3 space-y-3">
            <div class="text-xs font-medium text-themed">{{ $t('admin.botBridge.settings.expiryTitle') }}</div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-2">
                <label class="label">{{ $t('admin.botBridge.settings.expiryEnabled') }}</label>
                <select v-model="expiryReminderEnabled" class="input">
                  <option :value="true">{{ $t('admin.botBridge.settings.guardOn') }}</option>
                  <option :value="false">{{ $t('admin.botBridge.settings.guardOff') }}</option>
                </select>
              </div>
              <div class="space-y-2">
                <label class="label">{{ $t('admin.botBridge.settings.expiryReminderDays') }}</label>
                <div class="flex gap-2">
                  <input
                    v-model.number="expiryReminderDays"
                    type="number"
                    min="0"
                    max="90"
                    class="input flex-1"
                  />
                  <span class="flex items-center whitespace-nowrap text-xs text-themed-muted">
                    {{ $t('admin.botBridge.settings.expiryReminderUnit') }}
                  </span>
                </div>
              </div>
            </div>
            <p class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.expiryReminderHint') }}</p>
            <div class="flex justify-end">
              <button class="btn btn-primary btn-sm" :disabled="savingExpiry" @click="saveExpirySettings">
                {{ savingExpiry ? $t('common.saving') : $t('common.save') }}
              </button>
            </div>
          </div>

          <!-- TGID 绑定：用户直接填 TGID，面板调 getChatMember 校验在群 + 取全名 -->
          <!-- 完全独立于「TG 设置」卡片：不需要 webhook，所以不会和外部机器人冲突 -->
          <div class="rounded border border-themed bg-themed-secondary/30 p-3 space-y-3">
            <div class="text-xs font-medium text-themed">{{ $t('admin.botBridge.settings.tgBindTitle') }}</div>
            <p class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.tgBindDesc') }}</p>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-2">
                <label class="label">{{ $t('admin.botBridge.settings.tgBindEnabled') }}</label>
                <select v-model="tgBindEnabled" class="input">
                  <option :value="true">{{ $t('admin.botBridge.settings.guardOn') }}</option>
                  <option :value="false">{{ $t('admin.botBridge.settings.guardOff') }}</option>
                </select>
              </div>
              <div class="space-y-2">
                <label class="label">{{ $t('admin.botBridge.settings.tgBindGroupChatId') }}</label>
                <input v-model="tgBindGroupChatId" type="text" class="input" placeholder="-1001234567890" />
              </div>
            </div>

            <div class="space-y-2">
              <label class="label">{{ $t('admin.botBridge.settings.tgBindBotToken') }}</label>
              <input
                v-model="tgBindBotTokenInput"
                type="text"
                class="input"
                :placeholder="settings?.tgBindHasToken
                  ? $t('admin.botBridge.settings.tgBindTokenSet')
                  : $t('admin.botBridge.settings.tgBindTokenEmpty')"
              />
              <p class="text-xs text-themed-muted">{{ $t('admin.botBridge.settings.tgBindTokenHint') }}</p>
            </div>

            <p v-if="settings?.tgBindAvailable" class="text-xs text-green-500">
              {{ $t('admin.botBridge.settings.tgBindReady') }}
            </p>
            <p v-else class="text-xs text-amber-500">
              {{ $t('admin.botBridge.settings.tgBindNotReady') }}
            </p>

            <div class="flex justify-end">
              <button class="btn btn-primary btn-sm" :disabled="savingTgBind" @click="saveTgBindSettings">
                {{ savingTgBind ? $t('common.saving') : $t('common.save') }}
              </button>
            </div>
          </div>

          <p class="text-xs text-red-500">{{ $t('admin.botBridge.settings.warning') }}</p>

          <!-- 操作 -->
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-2">
              <label class="label">{{ $t('admin.botBridge.settings.setToken') }}</label>
              <input
                v-model="settingsTokenInput"
                class="input w-full font-mono text-xs"
                :placeholder="$t('admin.botBridge.settings.tokenPlaceholder')"
                autocomplete="off"
              />
              <button class="btn btn-primary btn-sm" :disabled="settingsSaving" @click="saveSettingsToken">
                {{ settingsSaving ? $t('common.processing') : $t('admin.botBridge.settings.save') }}
              </button>
            </div>
            <div class="space-y-2">
              <label class="label">{{ $t('admin.botBridge.settings.actions') }}</label>
              <div class="flex flex-wrap gap-2">
                <button class="btn btn-ghost btn-sm" :disabled="settingsSaving" @click="generateSettingsToken">
                  {{ $t('admin.botBridge.settings.generate') }}
                </button>
                <button
                  class="btn btn-ghost btn-sm text-red-500"
                  :disabled="settingsSaving || !settings?.enabled"
                  @click="disableSettings"
                >
                  {{ $t('admin.botBridge.settings.disable') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>

    <!-- ==================== 守护日志详情弹窗 ==================== -->
    <div v-if="guardDetailOpen" class="modal-overlay" @click.self="guardDetailOpen = false">
      <div
        class="modal-content"
        style="width: 96vw; max-width: min(1280px, 96vw); height: 72vh; overflow: auto; padding: 28px 32px;"
      >
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 class="text-base font-semibold text-themed">{{ $t('admin.botBridge.guardDetail.title') }}</h3>
            <p v-if="guardDetail" class="mt-1 text-xs text-themed-muted">
              {{ formatDate(guardDetail.runAt) }} · {{ guardDetail.source }} ·
              {{ $t('admin.botBridge.guard.chatId') }}
              <template v-if="chatTitle">{{ chatTitle }}</template>
              <template v-else>{{ guardDetail.chatId || '-' }}</template>
            </p>
          </div>
          <button class="btn-ghost btn-sm" @click="guardDetailOpen = false">✕</button>
        </div>

        <div v-if="guardDetailLoading" class="py-10 text-center text-sm text-themed-muted">
          {{ $t('common.loading') }}
        </div>

        <template v-else-if="guardDetail">
          <!-- 汇总 -->
          <div class="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div class="rounded border border-themed p-2">
              <div class="text-themed-muted">{{ $t('admin.botBridge.guard.total') }}</div>
              <div class="text-lg font-semibold">{{ guardDetail.total }}</div>
            </div>
            <div class="rounded border border-themed p-2">
              <div class="text-themed-muted">{{ $t('admin.botBridge.guard.inGroup') }}</div>
              <div class="text-lg font-semibold text-green-500">{{ guardDetail.inGroup }}</div>
            </div>
            <div class="rounded border border-themed p-2">
              <div class="text-themed-muted">{{ $t('admin.botBridge.guard.leftGroup') }}</div>
              <div class="text-lg font-semibold" :class="guardDetail.leftGroup > 0 ? 'text-red-500' : ''">{{ guardDetail.leftGroup }}</div>
            </div>
            <div class="rounded border border-themed p-2">
              <div class="text-themed-muted">{{ $t('admin.botBridge.guard.failed') }}</div>
              <div class="text-lg font-semibold" :class="guardDetail.failed > 0 ? 'text-red-500' : ''">{{ guardDetail.failed }}</div>
            </div>
          </div>

          <!-- 处置作业进度（异步：可能还在跑） -->
          <div v-if="guardDetail.enforceJob" class="mb-4 rounded border border-themed bg-themed-secondary/40 p-3 text-xs">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="badge"
                :class="{
                  'badge-success': guardDetail.enforceJob.status === 'completed',
                  'badge-warning': guardDetail.enforceJob.status === 'running',
                  'badge-error': guardDetail.enforceJob.status === 'partial' || guardDetail.enforceJob.status === 'failed'
                }"
              >{{ $t(`admin.botBridge.guardDetail.jobStatus.${guardDetail.enforceJob.status}`) }}</span>
              <span class="text-themed-muted">
                {{ $t('admin.botBridge.guardDetail.jobProgress', {
                  done: guardDetail.enforceJob.doneInstances,
                  total: guardDetail.enforceJob.totalInstances
                }) }}
              </span>
              <span class="text-themed-muted">
                {{ $t('admin.botBridge.guardDetail.jobIncus', {
                  deleted: guardDetail.enforceJob.incusDeleted,
                  failed: guardDetail.enforceJob.incusFailed
                }) }}
              </span>
              <button
                v-if="guardDetail.enforceJob.status === 'running'"
                class="btn btn-ghost btn-sm ml-auto"
                :disabled="guardDetailLoading"
                @click="openGuardDetail(guardDetail.id)"
              >{{ $t('common.refresh') }}</button>
            </div>
            <p v-if="guardDetail.enforceJob.status === 'running'" class="mt-2 text-themed-muted">
              {{ $t('admin.botBridge.guardDetail.jobRunningHint') }}
            </p>
            <p
              v-else-if="guardDetail.enforceJob.status === 'partial' || guardDetail.enforceJob.status === 'failed'"
              class="mt-2 text-amber-500"
            >{{ $t('admin.botBridge.guardDetail.jobPartialHint') }}</p>
          </div>

          <!-- 处置清单 -->
          <div v-if="guardDetail.enforced" class="mb-4 rounded border border-red-500/40 bg-red-500/5 p-3">
            <div class="mb-2 text-xs font-medium text-red-500">
              {{ $t('admin.botBridge.guardDetail.enforced') }}
              <span v-if="guardDetail.enforced.dryRun" class="text-themed-muted">({{ $t('admin.botBridge.guardDetail.dryRun') }})</span>
            </div>
            <div v-if="guardDetail.enforced.instances.length" class="space-y-1 text-xs">
              <div v-for="inst in guardDetail.enforced.instances" :key="inst.id" class="font-mono">
                #{{ inst.id }} <b>{{ inst.name }}</b>
                <span class="text-themed-muted">({{ inst.username }})</span>
              </div>
            </div>
            <div v-else class="text-xs text-themed-muted">{{ $t('admin.botBridge.guardDetail.noEnforced') }}</div>

            <!-- 自动解绑名单 -->
            <div v-if="guardDetail.enforced.unbound && guardDetail.enforced.unbound.length" class="mt-3 border-t border-red-500/30 pt-2">
              <div class="mb-1 text-xs font-medium text-amber-500">
                {{ $t('admin.botBridge.guardDetail.unbound') }} ({{ guardDetail.enforced.unbound.length }})
              </div>
              <div class="space-y-1 text-xs">
                <div v-for="u in guardDetail.enforced.unbound" :key="u.userId" class="font-mono">
                  #{{ u.userId }} <b>{{ u.username || '-' }}</b>
                  <span class="text-themed-muted">TGID {{ u.telegramUserId }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 明细分页签 -->
          <div v-if="guardDetail.details && guardDetail.details.length" class="space-y-2">
            <div class="flex gap-2">
              <button
                class="btn btn-sm"
                :class="guardDetailTab === 'normal' ? 'btn-primary' : 'btn-ghost'"
                @click="guardDetailTab = 'normal'"
              >{{ $t('admin.botBridge.guardDetail.normal') }} ({{ guardDetailNormal.length }})</button>
              <button
                class="btn btn-sm"
                :class="guardDetailTab === 'abnormal' ? 'btn-primary' : 'btn-ghost'"
                @click="guardDetailTab = 'abnormal'"
              >{{ $t('admin.botBridge.guardDetail.abnormal') }} ({{ guardDetailAbnormal.length }})</button>
            </div>

            <div class="max-h-[55vh] overflow-y-auto rounded border border-themed">
              <table class="w-full text-xs">
                <thead class="sticky top-0 bg-themed-secondary">
                  <tr>
                    <th class="p-2 text-left w-[19ch]">{{ $t('admin.botBridge.guardDetail.tg') }}</th>
                    <th class="p-2 text-left">{{ $t('admin.botBridge.guardDetail.nickname') }}</th>
                    <th class="p-2 text-left">TGID</th>
                    <th class="p-2 text-left">{{ $t('admin.botBridge.guardDetail.clientId') }}</th>
                    <th class="p-2 text-left">{{ $t('admin.botBridge.guardDetail.role') }}</th>
                    <th class="p-2 text-left">{{ $t('admin.botBridge.guardDetail.state') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="d in (guardDetailTab === 'normal' ? guardDetailNormal : guardDetailAbnormal)"
                    :key="d.tgUserId"
                    class="border-t border-themed"
                  >
                    <td
                      class="p-2 font-mono w-[19ch] max-w-[19ch] truncate"
                      :title="'@' + (d.tgUsername || '-')"
                    >@{{ d.tgUsername || '-' }}</td>
                    <td class="p-2 max-w-[160px] truncate" :title="d.tgNickname">{{ d.tgNickname || '-' }}</td>
                    <td class="p-2 font-mono text-themed-muted">{{ d.tgUserId }}</td>
                    <td class="p-2">
                      <span v-if="d.username" class="font-medium">{{ d.username }}</span>
                      <span v-else class="text-themed-muted">#{{ d.clientId }}</span>
                    </td>
                    <td class="p-2">
                      <span class="badge" :class="d.statusText === 'creator' || d.statusText === 'administrator' ? 'badge-warning' : 'badge-default'">
                        {{ roleLabel(d.statusText) }}
                      </span>
                    </td>
                    <td class="p-2">
                      <span :class="d.member ? 'text-green-500' : 'text-red-500'">{{ d.message }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-else class="rounded border border-themed p-4 text-center text-xs text-themed-muted">
            {{ $t('admin.botBridge.guardDetail.noDetails') }}
          </div>
        </template>
      </div>
    </div>
</template>
