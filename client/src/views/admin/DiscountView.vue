<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import api from '@/api'
import { useToast } from '@/stores/toast'

const { t } = useI18n()
const toast = useToast()

interface CatalogPkg {
  id: number
  name: string
  plans: Array<{ id: number; name: string; billingCycle?: number | null }>
  regions: Array<{ hostId: number; hostName: string; location: string; country?: string | null; countryCode?: string | null }>
}

interface PromoRow {
  id: number
  code: string
  itemName: string | null
  amount: number
  status: string
  scene: string
  cycleMonths: number | null
  reason: string | null
  usedAt: string | null
  usedInstanceId: number | null
  usedInstanceName: string | null
  usedByTelegramId: string | null
  usedByUserId: number | null
  usedByUsername: string | null
  expiresAt: string
  createdAt: string
}

const form = ref({
  itemName: '',
  amount: 1000,
  scene: 'purchase' as 'purchase' | 'renew',
  cycleMonths: 3,
  ttlDays: 7,
  count: 1,
  note: ''
})

const generating = ref(false)
const created = ref<string[]>([])

// ===== 目录（地区 / 套餐）=====
const catalogPkgs = ref<CatalogPkg[]>([])
const regionLabel = ref('')
const pkgLabel = ref('')

const regionPkgMap = computed(() => {
  const m = new Map<string, string[]>()
  for (const p of catalogPkgs.value) {
    for (const r of p.regions || []) {
      // 地区名优先用「节点设置的国家」，没有才回落到 location / 节点名
      const label = String(r.country || r.location || r.hostName || '').trim()
      if (!label) continue
      const list = m.get(label) || []
      if (!list.includes(p.name)) list.push(p.name)
      m.set(label, list)
    }
  }
  return m
})
const allPkgNames = computed(() => catalogPkgs.value.map((p) => p.name))
const regionOptions = computed(() => Array.from(regionPkgMap.value.keys()))
const pkgOptions = computed(() =>
  regionLabel.value ? (regionPkgMap.value.get(regionLabel.value) || []) : allPkgNames.value
)

async function loadCatalog() {
  try {
    const res: any = await (api.admin as any).getBotCatalog()
    catalogPkgs.value = Array.isArray(res?.packages) ? res.packages : []
  } catch {
    catalogPkgs.value = []
  }
}

// 套餐的计费周期（月）→ 券的适用周期。选套餐时自动带出来，不需要手工设。
function cycleFromPackage(pkgName: string): number | null {
  const pkg = catalogPkgs.value.find((p) => p.name === pkgName)
  const c = pkg?.plans?.[0]?.billingCycle
  return c && c > 0 ? Number(c) : null
}

// 周期文案统一：月 / 季度 / 半年 / 年
const CYCLE_LABEL: Record<number, string> = { 1: 'cycle1', 3: 'cycle3', 6: 'cycle6', 12: 'cycle12' }
function cycleLabel(months: number | null | undefined): string {
  if (!months) return '-'
  const key = CYCLE_LABEL[Number(months)]
  return key ? t(`admin.discount.${key}`) : `${months} ${t('admin.discount.monthUnit')}`
}

// 商品名 = 「地区 · 套餐」：选地区/套餐时自动补齐，省得手打
function applyItemName() {
  const parts = [regionLabel.value, pkgLabel.value].filter(Boolean)
  if (parts.length) form.value.itemName = parts.join(' · ')
}

function onPkgChange() {
  const c = cycleFromPackage(pkgLabel.value)
  if (c) form.value.cycleMonths = c
  applyItemName()
}

function onRegionChange() {
  if (pkgLabel.value && !pkgOptions.value.includes(pkgLabel.value)) pkgLabel.value = ''
  applyItemName()
  onPkgChange()
}

// ===== 分类卡 + 分页 =====
const TABS = ['all', 'active', 'used', 'void', 'expired'] as const
type Tab = (typeof TABS)[number]
const activeTab = ref<Tab>('all')
const keyword = ref('')
const rows = ref<PromoRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const counts = ref<Record<string, number>>({ all: 0, active: 0, used: 0, void: 0, expired: 0 })

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

async function loadRows(p = page.value) {
  loading.value = true
  try {
    const res: any = await (api.admin as any).getBotPromos({
      page: p,
      pageSize: pageSize.value,
      status: activeTab.value === 'all' ? undefined : activeTab.value,
      keyword: keyword.value.trim() || undefined
    })
    rows.value = Array.isArray(res?.items) ? res.items : []
    total.value = Number(res?.total || 0)
    page.value = Number(res?.page || p)
  } catch (err: any) {
    toast.error(t('admin.discount.loadFailed') + ': ' + (err?.message || err))
  } finally {
    loading.value = false
  }
}

async function loadCounts() {
  const keys: Tab[] = ['all', 'active', 'used', 'void', 'expired']
  const next: Record<string, number> = {}
  await Promise.all(
    keys.map(async (k) => {
      try {
        const res: any = await (api.admin as any).getBotPromos({
          page: 1,
          pageSize: 1,
          status: k === 'all' ? undefined : k
        })
        next[k] = Number(res?.total || 0)
      } catch {
        next[k] = 0
      }
    })
  )
  counts.value = next
}

function switchTab(tab: Tab) {
  activeTab.value = tab
  void loadRows(1)
}

function onSearch() {
  void loadRows(1)
}

// ===== 生成 =====
async function submit() {
  const amount = Number(form.value.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    toast.error(t('admin.discount.invalidAmount'))
    return
  }
  generating.value = true
  created.value = []
  try {
    const res = await (api.admin as any).createBotPromo({
      itemName: form.value.itemName.trim() || undefined,
      amount,
      scene: form.value.scene,
      cycleMonths: Number(form.value.cycleMonths) || 1,
      ttlDays: Number(form.value.ttlDays) || 7,
      count: Number(form.value.count) || 1,
      note: form.value.note.trim() || undefined
    })
    created.value = res.created || []
    toast.success(t('admin.discount.created', { n: created.value.length }))
    await Promise.all([loadRows(1), loadCounts()])
  } catch (err: any) {
    toast.error(t('admin.discount.createFailed') + ': ' + (err?.message || err))
  } finally {
    generating.value = false
  }
}

// ===== 行操作 =====
const editing = ref<PromoRow | null>(null)
const editForm = ref({ itemName: '', amount: 0, scene: 'purchase', cycleMonths: 3, ttlDays: 7, note: '' })

function openEdit(row: PromoRow) {
  editing.value = row
  editForm.value = {
    itemName: row.itemName || '',
    amount: Number(row.amount),
    scene: row.scene,
    cycleMonths: row.cycleMonths || 1,
    ttlDays: Math.max(1, Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / 86400000)),
    note: row.reason || ''
  }
}

async function saveEdit() {
  if (!editing.value) return
  try {
    await (api.admin as any).updateBotPromo(editing.value.code, {
      itemName: editForm.value.itemName.trim() || undefined,
      amount: Number(editForm.value.amount),
      scene: editForm.value.scene,
      cycleMonths: Number(editForm.value.cycleMonths),
      ttlDays: Number(editForm.value.ttlDays),
      note: editForm.value.note.trim() || undefined
    })
    toast.success(t('admin.discount.saved'))
    editing.value = null
    await Promise.all([loadRows(), loadCounts()])
  } catch (err: any) {
    toast.error(t('admin.discount.saveFailed') + ': ' + (err?.message || err))
  }
}

async function voidCode(row: PromoRow) {
  if (!confirm(t('admin.discount.confirmVoid', { code: row.code }))) return
  try {
    await (api.admin as any).voidBotPromo(row.code)
    toast.success(t('admin.discount.voided'))
    await Promise.all([loadRows(), loadCounts()])
  } catch (err: any) {
    toast.error(t('admin.discount.opFailed') + ': ' + (err?.message || err))
  }
}

async function restoreCode(row: PromoRow) {
  try {
    await (api.admin as any).restoreBotPromo(row.code)
    toast.success(t('admin.discount.restored'))
    await Promise.all([loadRows(), loadCounts()])
  } catch (err: any) {
    toast.error(t('admin.discount.opFailed') + ': ' + (err?.message || err))
  }
}

async function removeCode(row: PromoRow) {
  if (!confirm(t('admin.discount.confirmDelete', { code: row.code }))) return
  try {
    await (api.admin as any).deleteBotPromo(row.code)
    toast.success(t('admin.discount.deleted'))
    await Promise.all([loadRows(), loadCounts()])
  } catch (err: any) {
    toast.error(t('admin.discount.opFailed') + ': ' + (err?.message || err))
  }
}

// ===== 核销详情弹窗 =====
// 已核销的券：点击行/状态徽章，弹窗显示「谁用了这张券 + 开了什么机器」
const usedDetail = ref<PromoRow | null>(null)
// 「可用」券：点击状态徽章看创建时间
const activeDetail = ref<PromoRow | null>(null)
const router = useRouter()


// 点状态列：已核销 → 核销详情；可用 → 创建时间
function openStatusDetail(row: PromoRow) {
  if (row.status === 'used') { usedDetail.value = row; return }
  if (row.status === 'active') { activeDetail.value = row }
}

// 跳转用户管理并自动搜索该用户
function gotoUser(username: string | null | undefined) {
  if (!username) return
  usedDetail.value = null
  router.push({ path: '/admin/users', query: { search: username, field: 'username' } })
}

// 跳转实例详情页
function gotoInstance(id: number | null | undefined) {
  if (!id) return
  usedDetail.value = null
  router.push(`/instances/${id}`)
}

// ===== 工具 =====
const sceneLabel = (s: string) => (s === 'renew' ? t('admin.discount.sceneRenew') : t('admin.discount.scenePurchase'))
const statusLabel = (s: string) => {
  if (s === 'active') return t('admin.discount.statusActive')
  if (s === 'used') return t('admin.discount.statusUsed')
  if (s === 'void') return t('admin.discount.statusVoid')
  if (s === 'expired') return t('admin.discount.statusExpired')
  return s
}
const statusClass = (s: string) => {
  if (s === 'active') return 'bg-green-500/15 text-green-600'
  if (s === 'used') return 'bg-blue-500/15 text-blue-600'
  if (s === 'void') return 'bg-red-500/15 text-red-600'
  return 'bg-themed-secondary text-themed-muted'
}
const isExpired = (row: PromoRow) => row.status === 'active' && new Date(row.expiresAt).getTime() < Date.now()

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('admin.discount.copied'))
  } catch {
    toast.error(t('admin.discount.copyFailed'))
  }
}
function copyAll() {
  if (created.value.length) void copyText(created.value.join('\n'))
}

onMounted(() => {
  void loadCatalog()
  void loadRows(1)
  void loadCounts()
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-themed">{{ t('admin.discount.title') }}</h1>
      <p class="mt-1 text-sm text-themed-muted">{{ t('admin.discount.subtitle') }}</p>
    </div>

    <!-- 生成折扣券 -->
    <div class="card p-5 space-y-4">
      <div class="text-sm font-medium text-themed">{{ t('admin.discount.createTitle') }}</div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.region') }}</label>
          <select v-model="regionLabel" class="input w-full" @change="onRegionChange">
            <option value="">{{ t('admin.discount.regionPlaceholder') }}</option>
            <option v-for="r in regionOptions" :key="r" :value="r">{{ r }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.package') }}</label>
          <select v-model="pkgLabel" class="input w-full" @change="onPkgChange">
            <option value="">{{ t('admin.discount.packagePlaceholder') }}</option>
            <option v-for="n in pkgOptions" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.itemName') }}</label>
          <input v-model="form.itemName" class="input w-full" :placeholder="t('admin.discount.itemNamePlaceholder')" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.scene') }}</label>
          <select v-model="form.scene" class="input w-full">
            <option value="purchase">{{ t('admin.discount.scenePurchase') }}</option>
            <option value="renew">{{ t('admin.discount.sceneRenew') }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.amount') }}</label>
          <input v-model.number="form.amount" type="number" min="1" class="input w-full" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.cycle') }}</label>
          <input
            :value="cycleLabel(form.cycleMonths)"
            class="input w-full opacity-70"
            readonly
            :title="t('admin.discount.cycleAutoHint')"
          />
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.ttlDays') }}</label>
          <input v-model.number="form.ttlDays" type="number" min="1" max="3650" class="input w-full" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.count') }}</label>
          <input v-model.number="form.count" type="number" min="1" max="50" class="input w-full" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.note') }}</label>
          <input v-model="form.note" class="input w-full" :placeholder="t('admin.discount.notePlaceholder')" />
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button class="btn-primary" :disabled="generating" @click="submit">
          {{ generating ? t('admin.discount.generating') : t('admin.discount.generate') }}
        </button>
        <span class="text-xs text-themed-muted">{{ t('admin.discount.hint') }}</span>
      </div>
    </div>

    <!-- 生成结果 -->
    <div v-if="created.length" class="card p-5 space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-sm font-medium text-themed">{{ t('admin.discount.resultTitle', { n: created.length }) }}</div>
        <button class="btn-ghost btn-sm" @click="copyAll">{{ t('admin.discount.copyAll') }}</button>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="c in created"
          :key="c"
          class="rounded border border-themed px-2 py-1 font-mono text-xs hover:bg-themed-secondary"
          @click="copyText(c)"
        >
          {{ c }}
        </button>
      </div>
    </div>

    <!-- 分类卡 -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
      <button
        v-for="tab in TABS"
        :key="tab"
        class="card px-4 py-3 text-left transition"
        :class="activeTab === tab ? 'ring-2 ring-blue-500' : 'hover:bg-themed-secondary/40'"
        @click="switchTab(tab)"
      >
        <div class="text-xs text-themed-muted">
          {{ tab === 'all' ? t('admin.discount.tabAll')
            : tab === 'active' ? t('admin.discount.tabActive')
            : tab === 'used' ? t('admin.discount.tabUsed')
            : tab === 'void' ? t('admin.discount.tabVoid')
            : t('admin.discount.tabExpired') }}
        </div>
        <div class="mt-1 text-2xl font-semibold text-themed">{{ counts[tab] ?? 0 }}</div>
      </button>
    </div>

    <!-- 列表 -->
    <div class="card overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-themed px-5 py-3">
        <div class="text-sm font-medium text-themed">{{ t('admin.discount.listTitle') }}</div>
        <div class="flex items-center gap-2">
          <input
            v-model="keyword"
            class="input"
            :placeholder="t('admin.discount.searchPlaceholder')"
            @keyup.enter="onSearch"
          />
          <button class="btn-ghost btn-sm" @click="onSearch">{{ t('admin.discount.search') }}</button>
          <button class="btn-ghost btn-sm" :disabled="loading" @click="loadRows()">{{ t('common.refresh') }}</button>
        </div>
      </div>

      <div v-if="loading" class="p-5 text-sm text-themed-muted">{{ t('common.loading') }}</div>
      <div v-else-if="!rows.length" class="p-5 text-sm text-themed-muted">{{ t('admin.discount.empty') }}</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[1080px] text-sm">
          <thead class="bg-themed-secondary/80">
            <tr>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colCode') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colItem') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colScene') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colCycle') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colAmount') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colStatus') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colExpires') }}</th>
              <th class="p-3 text-left whitespace-nowrap">{{ t('admin.discount.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.id"
              class="border-t border-themed hover:bg-themed-secondary/40"
            >
              <td class="p-3 font-mono text-xs whitespace-nowrap">
                <button class="hover:text-blue-500" @click.stop="copyText(row.code)">{{ row.code }}</button>
              </td>
              <td class="p-3 whitespace-nowrap">{{ row.itemName || '-' }}</td>
              <td class="p-3 whitespace-nowrap">{{ sceneLabel(row.scene) }}</td>
              <td class="p-3 whitespace-nowrap">{{ cycleLabel(row.cycleMonths) }}</td>
              <td class="p-3 whitespace-nowrap">¥{{ Number(row.amount).toFixed(2) }}</td>
              <td class="p-3 whitespace-nowrap">
                <span v-if="isExpired(row)" class="badge bg-themed-secondary text-themed-muted">{{ t('admin.discount.statusExpired') }}</span>
                <span
                  v-else
                  class="badge"
                  :class="[statusClass(row.status), (row.status === 'used' || row.status === 'active') ? 'cursor-pointer hover:opacity-80' : '']"
                  :title="row.status === 'used' ? t('admin.discount.usedDetailTitle') : (row.status === 'active' ? t('admin.discount.createdAt') : '')"
                  @click.stop="openStatusDetail(row)"
                >{{ statusLabel(row.status) }}</span>
              </td>
              <td class="p-3 whitespace-nowrap text-xs text-themed-muted">{{ new Date(row.expiresAt).toLocaleString() }}</td>
              <td class="p-3 whitespace-nowrap">
                <div class="flex items-center gap-1">
                  <button v-if="row.status !== 'used'" class="btn-ghost btn-sm" @click="openEdit(row)">{{ t('admin.discount.edit') }}</button>
                  <button v-if="row.status === 'active'" class="btn-ghost btn-sm text-red-500" @click="voidCode(row)">{{ t('admin.discount.void') }}</button>
                  <button v-if="row.status === 'void'" class="btn-ghost btn-sm" @click="restoreCode(row)">{{ t('admin.discount.restore') }}</button>
                  <button v-if="row.status !== 'used'" class="btn-ghost btn-sm text-red-500" @click="removeCode(row)">{{ t('admin.discount.delete') }}</button>
                  <span v-if="row.status === 'used'" class="text-xs text-themed-muted">{{ t('admin.discount.noAction') }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 border-t border-themed px-5 py-3">
        <button class="btn-ghost btn-sm" :disabled="page <= 1 || loading" @click="loadRows(page - 1)">
          {{ t('admin.discount.prev') }}
        </button>
        <span class="text-xs text-themed-muted">{{ page }} / {{ totalPages }} · {{ t('admin.discount.totalRows', { n: total }) }}</span>
        <button class="btn-ghost btn-sm" :disabled="page >= totalPages || loading" @click="loadRows(page + 1)">
          {{ t('admin.discount.next') }}
        </button>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="editing" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="card w-full max-w-lg p-5 space-y-4">
        <div class="text-sm font-medium text-themed">{{ t('admin.discount.editTitle') }} · <code class="text-xs">{{ editing.code }}</code></div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div class="md:col-span-2">
            <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.itemName') }}</label>
            <input v-model="editForm.itemName" class="input w-full" />
          </div>
          <div>
            <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.amount') }}</label>
            <input v-model.number="editForm.amount" type="number" min="1" class="input w-full" />
          </div>
          <div>
            <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.scene') }}</label>
            <select v-model="editForm.scene" class="input w-full">
              <option value="purchase">{{ t('admin.discount.scenePurchase') }}</option>
              <option value="renew">{{ t('admin.discount.sceneRenew') }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.cycle') }}</label>
            <select v-model.number="editForm.cycleMonths" class="input w-full">
              <option :value="1">{{ t('admin.discount.cycle1') }}</option>
              <option :value="3">{{ t('admin.discount.cycle3') }}</option>
              <option :value="6">{{ t('admin.discount.cycle6') }}</option>
              <option :value="12">{{ t('admin.discount.cycle12') }}</option>
            </select>
          </div>
          <div>
            <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.ttlDays') }}</label>
            <input v-model.number="editForm.ttlDays" type="number" min="1" max="3650" class="input w-full" />
          </div>
          <div class="md:col-span-2">
            <label class="mb-1.5 block text-xs text-themed-muted">{{ t('admin.discount.note') }}</label>
            <input v-model="editForm.note" class="input w-full" />
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button class="btn-ghost" @click="editing = null">{{ t('common.cancel') }}</button>
          <button class="btn-primary" @click="saveEdit">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 核销详情弹窗：谁用了这张券 + 开了什么机器 -->
    <div
      v-if="usedDetail"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="usedDetail = null"
    >
      <div class="card w-full max-w-lg p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div class="text-sm font-medium text-themed">{{ t('admin.discount.usedDetailTitle') }}</div>
          <button class="btn-ghost btn-sm" @click="usedDetail = null">{{ t('common.close') }}</button>
        </div>
        <div class="space-y-3 text-sm">
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colCode') }}</span>
            <span class="font-mono text-xs">{{ usedDetail.code }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.usedBy') }}</span>
            <button
              v-if="usedDetail.usedByUsername"
              class="text-blue-500 hover:underline text-right"
              @click="gotoUser(usedDetail.usedByUsername)"
            >{{ usedDetail.usedByUsername }}</button>
            <span v-else class="text-themed">-</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.usedByTgId') }}</span>
            <span class="font-mono text-xs">{{ usedDetail.usedByTelegramId || '-' }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.usedInstanceName') }}</span>
            <button
              v-if="usedDetail.usedInstanceId"
              class="text-blue-500 hover:underline text-right"
              @click="gotoInstance(usedDetail.usedInstanceId)"
            >{{ usedDetail.usedInstanceName || ('#' + usedDetail.usedInstanceId) }}</button>
            <span v-else class="text-themed">-</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.usedInstanceId') }}</span>
            <span class="text-themed">{{ usedDetail.usedInstanceId ?? '-' }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.usedAt') }}</span>
            <span class="text-themed">{{ usedDetail.usedAt ? new Date(usedDetail.usedAt).toLocaleString() : '-' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 「可用」券详情弹窗：看创建时间 -->
    <div
      v-if="activeDetail"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="activeDetail = null"
    >
      <div class="card w-full max-w-md p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div class="text-sm font-medium text-themed">{{ t('admin.discount.activeDetailTitle') }}</div>
          <button class="btn-ghost btn-sm" @click="activeDetail = null">{{ t('common.close') }}</button>
        </div>
        <div class="space-y-3 text-sm">
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colCode') }}</span>
            <span class="font-mono text-xs">{{ activeDetail.code }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colItem') }}</span>
            <span class="text-themed text-right">{{ activeDetail.itemName || '-' }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colScene') }}</span>
            <span class="text-themed">{{ sceneLabel(activeDetail.scene) }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colCycle') }}</span>
            <span class="text-themed">{{ cycleLabel(activeDetail.cycleMonths) }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colAmount') }}</span>
            <span class="text-themed">¥{{ Number(activeDetail.amount).toFixed(2) }}</span>
          </div>
          <div class="flex items-center justify-between gap-4 border-t border-themed pt-3">
            <span class="text-themed-muted">{{ t('admin.discount.createdAt') }}</span>
            <span class="text-themed font-medium">{{ activeDetail.createdAt ? new Date(activeDetail.createdAt).toLocaleString() : '-' }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-themed-muted">{{ t('admin.discount.colExpires') }}</span>
            <span class="text-themed">{{ activeDetail.expiresAt ? new Date(activeDetail.expiresAt).toLocaleString() : '-' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
