import { createI18n } from 'vue-i18n'

// 使用类型导入（仅编译期，不打包进 bundle）
export type MessageSchema = typeof import('./zh-CN').default
export type Locale = 'zh-CN' | 'zh-TW' | 'en'

// 支援的語言列表
const supportedLocales: { code: Locale; name: string }[] = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
]

// 檢測瀏覽器語言
function detectBrowserLocale(): Locale {
    const browserLang = navigator.language || (navigator as { userLanguage?: string }).userLanguage || ''

    // 中文區分簡體/繁體
    if (browserLang.startsWith('zh')) {
        // zh-TW, zh-HK, zh-Hant 等使用繁體
        if (browserLang.includes('TW') || browserLang.includes('HK') || browserLang.includes('Hant')) {
            return 'zh-TW'
        }
        // 其他中文默認簡體
        return 'zh-CN'
    }

    // 其他語言默認英文
    return 'en'
}

// 取得儲存的語言或檢測瀏覽器語言
function getInitialLocale(): Locale {
    const saved = localStorage.getItem('locale') as Locale | null
    if (saved && supportedLocales.some(l => l.code === saved)) {
        return saved
    }
    return detectBrowserLocale()
}

// 匯出支援的語言列表
export { supportedLocales }

// 所有語言的動態加載器（Vite 會為每個語言生成獨立 chunk，按需加載）
// 使用宽松类型避免各语言文件间的字段差异导致类型不兼容
const localeLoaders: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
    'zh-CN': () => import('./zh-CN'),
    'zh-TW': () => import('./zh-TW'),
    'en': () => import('./en'),
}

const initialLocale = getInitialLocale()

const i18n = createI18n({
    legacy: false, // 使用 Composition API 模式
    locale: initialLocale,
    fallbackLocale: 'zh-CN', // 回退到默認語言
    messages: {}, // 所有語言按需加載，不內置
})

// 已加載的語言集合
const loadedLocales = new Set<Locale>()

// 確保指定語言的消息已加載
async function ensureLocaleMessages(locale: Locale): Promise<void> {
    if (loadedLocales.has(locale)) return
    const loader = localeLoaders[locale]
    if (!loader) return
    const mod = await loader()
    i18n.global.setLocaleMessage(locale, mod.default as any)
    loadedLocales.add(locale)
}

/**
 * 應用啟動前預加載用戶選擇的語言
 * 所有語言（包括 zh-CN）均按需異步加載，降低主 bundle 體積
 * 如果初始語言非 zh-CN，同時預加載 zh-CN 作為 fallback
 */
export async function initLocale(): Promise<void> {
    const tasks = [ensureLocaleMessages(initialLocale)]
    if (initialLocale !== 'zh-CN') {
        tasks.push(ensureLocaleMessages('zh-CN'))
    }
    await Promise.all(tasks)
    ;(i18n.global.locale as any).value = initialLocale
}

// 切換語言並加載對應消息
export async function setLocale(newLocale: Locale): Promise<void> {
    await ensureLocaleMessages(newLocale)
    ; (i18n.global.locale as any).value = newLocale
    localStorage.setItem('locale', newLocale)
    // 設定 HTML lang 屬性
    document.documentElement.lang = newLocale
}

// 取得目前語言
export function getLocale(): Locale {
    return (i18n.global.locale as any).value as Locale
}

// 取得目前語言的簡寫
// 用於顯示在 UI 上（如語言切換按鈕）
export function getCurrentLocaleShort(): string {
    const locale = getLocale()
    switch (locale) {
        case 'zh-CN':
            return '简'
        case 'zh-TW':
            return '繁'
        case 'en':
            return 'EN'
        default:
            return 'EN'
    }
}

export default i18n
