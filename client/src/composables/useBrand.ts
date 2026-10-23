import { useConfigStore } from '@/stores/config'

export function useBrand() {
  const configStore = useConfigStore()

  return {
    get brandName() {
      return configStore.brandName?.trim() || '蛋蛋云'
    },
    get brandSubtitle() {
      return configStore.brandSubtitle?.trim() || '基于 Incus 的低价 NAT VPS'
    },
    get brandLogoUrl() {
      return configStore.brandLogoUrl?.trim() || '/logo-dandan-512.png'
    }
  }
}
