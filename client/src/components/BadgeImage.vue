<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { useBadgeStore } from '@/stores/badges'

const props = withDefaults(defineProps<{
  badgeId: string
  size?: number
  alt?: string
  variant?: 'avatar' | 'icon' | 'plain'
}>(), {
  size: 32,
  alt: '',
  variant: 'icon'
})

const themeStore = useThemeStore()
const badgeStore = useBadgeStore()

onMounted(() => {
  badgeStore.ensureBadge(props.badgeId)
})

watch(() => props.badgeId, (badgeId) => {
  badgeStore.ensureBadge(badgeId)
})

const sizeStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`
}))

const roundedClass = computed(() => {
  if (props.variant === 'avatar') return 'rounded-full'
  if (props.variant === 'icon') return 'rounded-xl'
  return ''
})

const badgeUrl = computed(() => {
  const badge = badgeStore.getBadge(props.badgeId)
  if (badge) {
    if (themeStore.isDark) {
      return badge.assetUrlDark || badge.assetUrl || `/badges/dark/${props.badgeId}.svg`
    }
    return badge.assetUrlLight || badge.assetUrl || `/badges/light/${props.badgeId}.svg`
  }

  return `/badges/${themeStore.isDark ? 'dark' : 'light'}/${props.badgeId}.svg`
})

// 图片加载失败时显示占位符，避免破碎图标
const showPlaceholder = ref(false)

function handleError() {
  showPlaceholder.value = true
}

// badgeId 或主题切换时重置错误状态，重新尝试加载
watch([() => props.badgeId, () => themeStore.isDark], () => {
  showPlaceholder.value = false
})
</script>

<template>
  <div
    v-if="showPlaceholder"
    :class="[roundedClass, 'flex items-center justify-center shrink-0 bg-themed/10']"
    :style="sizeStyle"
  >
    <span class="text-[10px] font-medium text-themed-muted uppercase">{{ badgeId.charAt(0) }}</span>
  </div>
  <img
    v-else
    :src="badgeUrl"
    :alt="alt || badgeId"
    loading="lazy"
    class="object-contain shrink-0"
    :class="roundedClass"
    :style="sizeStyle"
    @error="handleError"
  />
</template>
