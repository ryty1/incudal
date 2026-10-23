import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

type PopupPromoPackage = {
    id: number
    name: string
    description: string | null
    source: 'official' | 'market'
    plans: Array<{
        id: number
        name: string
        description: string | null
        cpu: number
        memory: number
        disk: number
        trafficLimit: string
        price: number
        billingCycle: number
        isSoldOut: boolean
    }>
}

const BRAND_CACHE_KEY = 'incudal_brand_cache'
const DEFAULT_LOGO = '/logo-dandan-512.png'

function readBrandCache(): { name?: string; subtitle?: string; logo?: string } {
    try {
        return JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || '{}')
    } catch {
        return {}
    }
}

export const useConfigStore = defineStore('config', () => {
    // 首屏用上一次成功加载的品牌信息，避免刷新时先闪一下默认/旧 logo
    const cachedBrand = readBrandCache()
    const avatarApiBase = ref('https://api.dicebear.com/9.x')
    const brandName = ref(cachedBrand.name || '蛋蛋云')
    const brandSubtitle = ref(cachedBrand.subtitle || '公益 NAT 云主机')
    const brandLogoUrl = ref(cachedBrand.logo || DEFAULT_LOGO)
    const registrationEnabled = ref(true)
    const requireInviteCode = ref(true)
    const ticketEnabled = ref(true)
    const freeSiteMode = ref(false)
    const affRebateEnabled = ref(false)
    const mailAvailable = ref(true)
    const turnstileEnabled = ref(false)
    const turnstileSiteKey = ref<string | null>(null)
    const transferFee = ref(0)
    const balanceTransferEnabled = ref(false)
    const balanceTransferFee = ref(0)
    const footerContactEmail = ref<string | null>('incudal@sent.com')
    const footerTelegramLink = ref<string | null>('https://t.me/incudal_com')
    const hostingMarketEntryEnabled = ref(true)
    const hostingNotice = ref<string | null>(null)
    const popupAnnouncement = ref<string | null>(null)
    const popupAnnouncementUpdatedAt = ref<string | null>(null)
    const popupPromoImageUrl = ref<string | null>(null)
    const popupPromoPackage = ref<PopupPromoPackage | null>(null)
    const popupPromoUpdatedAt = ref<string | null>(null)
    const loaded = ref(false)

    // 缓存正在进行的请求 Promise，避免路由守卫多处同时调用时重复请求
    let loadPromise: Promise<void> | null = null

    async function loadPublicConfig(force = false) {
        if (loaded.value && !force) return
        if (loadPromise && !force) return loadPromise

        loadPromise = (async () => {
            try {
                const config = await api.systemConfig.getPublic()
                registrationEnabled.value = config.registrationEnabled ?? true
                requireInviteCode.value = config.requireInviteCode
                ticketEnabled.value = config.ticketEnabled ?? true
                freeSiteMode.value = config.freeSiteMode ?? false
                affRebateEnabled.value = config.affRebateEnabled ?? false
                mailAvailable.value = config.mailAvailable ?? true
                turnstileEnabled.value = config.turnstileEnabled || false
                turnstileSiteKey.value = config.turnstileSiteKey || null
                avatarApiBase.value = config.avatarApiBase || 'https://api.dicebear.com/9.x'
                brandName.value = config.brandName?.trim() || '蛋蛋云'
                brandSubtitle.value = config.brandSubtitle?.trim() || '基于 Incus 的低价 NAT VPS'
                brandLogoUrl.value = config.brandLogoUrl?.trim() || DEFAULT_LOGO
                try {
                    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify({
                        name: brandName.value,
                        subtitle: brandSubtitle.value,
                        logo: brandLogoUrl.value
                    }))
                } catch { /* localStorage 不可用时忽略 */ }
                transferFee.value = config.transferFee || 0
                balanceTransferEnabled.value = config.balanceTransferEnabled ?? false
                balanceTransferFee.value = config.balanceTransferFee || 0
                footerContactEmail.value = config.footerContactEmail ?? null
                footerTelegramLink.value = config.footerTelegramLink ?? null
                hostingMarketEntryEnabled.value = config.hostingMarketEntryEnabled ?? true
                hostingNotice.value = config.hostingNotice ?? null
                popupAnnouncement.value = config.popupAnnouncement ?? null
                popupAnnouncementUpdatedAt.value = config.popupAnnouncementUpdatedAt ?? null
                popupPromoImageUrl.value = config.popupPromoImageUrl ?? null
                popupPromoPackage.value = config.popupPromoPackage ?? null
                popupPromoUpdatedAt.value = config.popupPromoUpdatedAt ?? null
                loaded.value = true
            } catch (error) {
                console.error('Failed to load public config:', error)
            } finally {
                loadPromise = null
            }
        })()

        return loadPromise
    }

    return {
        avatarApiBase,
        brandName,
        brandSubtitle,
        brandLogoUrl,
        registrationEnabled,
        requireInviteCode,
        ticketEnabled,
        freeSiteMode,
        affRebateEnabled,
        mailAvailable,
        turnstileEnabled,
        turnstileSiteKey,
        transferFee,
        balanceTransferEnabled,
        balanceTransferFee,
        footerContactEmail,
        footerTelegramLink,
        hostingMarketEntryEnabled,
        hostingNotice,
        popupAnnouncement,
        popupAnnouncementUpdatedAt,
        popupPromoImageUrl,
        popupPromoPackage,
        popupPromoUpdatedAt,
        loaded,
        loadPublicConfig
    }
})
