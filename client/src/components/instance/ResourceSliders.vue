<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useThemeStore } from '@/stores/theme'
import ResourceSlider from './ResourceSlider.vue'
import type { Package, UserQuota } from '@/types/api'

const { t } = useI18n()

interface Props {
  selectedPackage: Package | null
  userQuota: UserQuota | null
  cpu: number
  memory: number
  disk: number
  stepNumber?: number  // 步骤编号，默认 2
  // 以下为「免费实例」额外资源限制，仅当 showQuotaSliders 为 true 时渲染（管理员创建页使用）
  showQuotaSliders?: boolean
  monthlyTrafficLimit?: number  // 月流量上限（GB）
  portLimit?: number            // 端口映射数上限
  snapshotLimit?: number        // 快照数上限
  siteLimit?: number            // 反代站点数上限
}

const props = withDefaults(defineProps<Props>(), {
  stepNumber: 2,
  showQuotaSliders: false,
  monthlyTrafficLimit: 0,
  portLimit: 0,
  snapshotLimit: 0,
  siteLimit: 0
})
const emit = defineEmits<{
  'update:cpu': [value: number]
  'update:memory': [value: number]
  'update:disk': [value: number]
  'update:monthlyTrafficLimit': [value: number]
  'update:portLimit': [value: number]
  'update:snapshotLimit': [value: number]
  'update:siteLimit': [value: number]
}>()

const themeStore = useThemeStore()

// CPU 配置
const cpuMin = 15
const cpuStep = 5
const cpuMax = computed(() => Math.max(15, props.selectedPackage?.cpu_max || 15))

// 内存配置
const memoryMin = 128
const memoryStep = 64
const memoryMax = computed(() => Math.max(128, props.selectedPackage?.memory_max || 128))

// 硬盘配置
const diskMin = 512
const diskStep = 64   // 64MB 步长，保证 512/768/1024 等常用值能精确落点
const diskMax = computed(() => Math.max(512, props.selectedPackage?.disk_max || 512))

// ===== 免费实例额外资源限制（流量/端口/快照/网站）=====
// 上限优先取套餐对应字段，取不到时给出合理默认值
const trafficMaxGb = computed(() => {
  const raw = props.selectedPackage?.monthly_traffic_limit
  if (!raw) return 1000
  const gb = Math.floor(Number(raw) / (1024 * 1024 * 1024))
  return gb > 0 ? gb : 1000
})
const portMax = computed(() => Math.max(1, props.selectedPackage?.port_limit ?? 20))
const snapshotMax = computed(() => Math.max(1, props.selectedPackage?.snapshot_limit ?? 5))
const siteMax = computed(() => Math.max(1, props.selectedPackage?.site_limit ?? 5))

// 格式化流量显示（GB）
function formatTraffic(gb: number): string {
  return `${gb} GB`
}

// 格式化数量显示
function formatCount(value: number): string {
  return `${value}`
}

// CPU 额配转换为核心数
function allowanceToCores(allowance: number): number {
  if (allowance <= 0) return 1
  return Math.ceil(allowance / 100)
}

// 格式化 CPU 显示
function formatCpu(value: number): string {
  return `${value}%`
}

// 格式化内存显示
function formatMemory(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
  }
  return `${mb} MB`
}

// 格式化硬盘显示（1024进制）
function formatDisk(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024
    return gb % 1 === 0 ? `${gb} GB` : `${gb.toFixed(1)} GB`
  }
  return `${mb} MB`
}

// CPU 图标
const cpuIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>`

// 内存图标
const memoryIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 19v-3"/><path d="M10 19v-3"/><path d="M14 19v-3"/><path d="M18 19v-3"/><path d="M8 11V9"/><path d="M16 11V9"/><path d="M12 11V9"/><path d="M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.8V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.8Z"/></svg>`

// 硬盘图标
const diskIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>`

// 流量图标
const trafficIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`

// 端口图标
const portIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M12 17v5"/><path d="M5 8h14l-1.5 6a4 4 0 0 1-3.9 3h-3.2a4 4 0 0 1-3.9-3Z"/></svg>`

// 快照图标
const snapshotIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/></svg>`

// 网站图标
const siteIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>`
</script>

<template>
  <div v-if="selectedPackage" class="card p-5">
    <div class="flex items-center gap-2 mb-5">
      <span 
        class="w-6 h-6 rounded-full text-sm font-bold flex items-center justify-center"
        :class="themeStore.isDark ? 'bg-white text-gray-900' : 'bg-gray-900 text-white'"
      >{{ props.stepNumber }}</span>
      <h2 
        class="text-sm font-medium"
        :class="themeStore.isDark ? 'text-gray-300' : 'text-gray-700'"
      >
        {{ t('instance.selector.configureResources') }}
      </h2>
      <span 
        class="text-xs ml-auto"
        :class="themeStore.isDark ? 'text-gray-600' : 'text-gray-500'"
      >{{ t('instance.selector.adjustBasedOnPackage') }}</span>
    </div>
    
    <!-- 剩余配额信息 -->
    <div 
      v-if="selectedPackage?.quotaInfo"
      class="mb-5 p-3 rounded-lg"
      :class="themeStore.isDark ? 'bg-gray-800/50' : 'bg-gray-50'"
    >
      <div class="text-xs text-gray-500 mb-2">{{ t('instance.createPage.quotaInfo.remaining') }}</div>
      <div 
        class="text-sm font-mono flex items-center flex-wrap gap-x-4 gap-y-1"
      >
        <span class="flex items-center gap-1.5">
          <span class="text-gray-500">{{ t('instance.createPage.quotaInfo.count') }}</span>
          <span 
            class="font-medium"
            :class="themeStore.isDark ? 'text-gray-200' : 'text-gray-800'"
          >
            {{ selectedPackage.quotaInfo.remainingInstances === null ? '∞' : selectedPackage.quotaInfo.remainingInstances }}
          </span>
        </span>
        <span v-if="selectedPackage.quotaInfo.remainingCpu !== null" class="text-gray-400">|</span>
        <span v-if="selectedPackage.quotaInfo.remainingCpu !== null" class="flex items-center gap-1.5">
          <span class="text-gray-500">CPU</span>
          <span 
            class="font-medium"
            :class="themeStore.isDark ? 'text-gray-200' : 'text-gray-800'"
          >
            {{ `${selectedPackage.quotaInfo.remainingCpu}%` }}
          </span>
        </span>
        <span v-if="selectedPackage.quotaInfo.remainingMemory !== null" class="text-gray-400">|</span>
        <span v-if="selectedPackage.quotaInfo.remainingMemory !== null" class="flex items-center gap-1.5">
          <span class="text-gray-500">{{ t('instance.createPage.quotaInfo.memory') }}</span>
          <span 
            class="font-medium"
            :class="themeStore.isDark ? 'text-gray-200' : 'text-gray-800'"
          >
            {{ formatMemory(selectedPackage.quotaInfo.remainingMemory) }}
          </span>
        </span>
      </div>
    </div>
    
    <!-- 资源配置滑块 -->
    <div class="space-y-6">
      <!-- CPU -->
      <ResourceSlider
        :model-value="cpu"
        :min="cpuMin"
        :max="cpuMax"
        :step="cpuStep"
        :label="t('instance.selector.cpu')"
        :subtitle="`~${allowanceToCores(cpu)} ${t('instance.selector.cores')}`"
        :format-value="formatCpu"
        :icon="cpuIcon"
        @update:model-value="emit('update:cpu', $event)"
      />
      
      <!-- 内存 -->
      <ResourceSlider
        :model-value="memory"
        :min="memoryMin"
        :max="memoryMax"
        :step="memoryStep"
        :label="t('instance.selector.memory')"
        :format-value="formatMemory"
        :icon="memoryIcon"
        @update:model-value="emit('update:memory', $event)"
      />
      
      <!-- 硬盘 -->
      <ResourceSlider
        :model-value="disk"
        :min="diskMin"
        :max="diskMax"
        :step="diskStep"
        :label="t('instance.selector.disk')"
        :format-value="formatDisk"
        :icon="diskIcon"
        @update:model-value="emit('update:disk', $event)"
      />

      <!-- 免费实例额外资源限制：流量 / 端口 / 快照 / 网站（仅管理员创建页启用） -->
      <template v-if="showQuotaSliders">
        <!-- 月流量 -->
        <ResourceSlider
          :model-value="monthlyTrafficLimit"
          :min="0"
          :max="trafficMaxGb"
          :step="10"
          :label="t('admin.instanceCreate.trafficLimit')"
          :subtitle="t('admin.instanceCreate.trafficLimitUnit')"
          :format-value="formatTraffic"
          :icon="trafficIcon"
          @update:model-value="emit('update:monthlyTrafficLimit', $event)"
        />

        <!-- 端口 -->
        <ResourceSlider
          :model-value="portLimit"
          :min="0"
          :max="portMax"
          :step="1"
          :label="t('admin.instanceCreate.portLimit')"
          :format-value="formatCount"
          :icon="portIcon"
          @update:model-value="emit('update:portLimit', $event)"
        />

        <!-- 快照 -->
        <ResourceSlider
          :model-value="snapshotLimit"
          :min="0"
          :max="snapshotMax"
          :step="1"
          :label="t('admin.instanceCreate.snapshotLimit')"
          :format-value="formatCount"
          :icon="snapshotIcon"
          @update:model-value="emit('update:snapshotLimit', $event)"
        />

        <!-- 网站 -->
        <ResourceSlider
          :model-value="siteLimit"
          :min="0"
          :max="siteMax"
          :step="1"
          :label="t('admin.instanceCreate.siteLimit')"
          :format-value="formatCount"
          :icon="siteIcon"
          @update:model-value="emit('update:siteLimit', $event)"
        />

        <!-- 校验提示 -->
        <p
          class="text-xs"
          :class="themeStore.isDark ? 'text-gray-500' : 'text-gray-400'"
        >
          {{ t('admin.instanceCreate.resourceLimitHint') }}
        </p>
      </template>
    </div>
  </div>
</template>
