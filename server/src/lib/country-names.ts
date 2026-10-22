/**
 * 节点国家代码 → 中文地区名。
 *
 * 面板和机器人里的标签都长成「地区 · 套餐」，Intl.DisplayNames('zh-CN') 给出的
 * 官方全称太长（中国香港特别行政区 / 阿拉伯联合酋长国 / 美利坚合众国…），
 * 一列标签能占掉半个屏幕，所以这里统一收敛成短名。
 *
 * 覆盖表优先，未命中的才回落到 Intl；这样不受 Node/ICU 版本变化影响
 * （不同 ICU 版本对同一地区给的名字并不一致）。
 */

const SHORT_REGION_NAMES: Record<string, string> = {
    HK: '中国香港',
    MO: '中国澳门',
    TW: '台湾',
    AE: '阿联酋',
    KR: '韩国',
    US: '美国',
    SG: '新加坡',
    AU: '澳大利亚',
    ID: '印尼',
    // 以下为常见长名的通用简称（VPS 面板实际会卖到的地区）
    BA: '波黑',
    SA: '沙特',
    KZ: '哈萨克',
    UZ: '乌兹别克',
    KG: '吉尔吉斯',
    TJ: '塔吉克',
    TM: '土库曼',
    DO: '多米尼加',
    CF: '中非',
    CD: '刚果金',
    CG: '刚果布',
    PG: '巴新',
    ET: '埃塞',
    AG: '安提瓜',
    KN: '圣基茨',
    ST: '圣多美',
    TT: '特立尼达',
    VC: '圣文森特',
    NC: '新喀',
    VG: '英属维京',
    VI: '美属维京',
    MP: '北马里亚纳',
    FK: '福克兰',
    PS: '巴勒斯坦',
    BQ: '荷属加勒比'
}

const regionDisplay = (() => {
    try {
        return new Intl.DisplayNames(['zh-CN'], { type: 'region' })
    } catch {
        return null
    }
})()

/** 国家代码（两位字母）→ 中文短名；非法代码返回 null。 */
export function countryName(code: string | null | undefined): string | null {
    const c = String(code || '').trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(c)) return null

    const short = SHORT_REGION_NAMES[c]
    if (short) return short

    try {
        return regionDisplay?.of(c) ?? null
    } catch {
        return null
    }
}

/** 把已有文本里的长地区名替换成短名（用于历史券的 item_name 等存量数据）。 */
export function shortenRegionText(text: string): string {
    let out = text
    for (const [code, short] of Object.entries(SHORT_REGION_NAMES)) {
        const long = (() => {
            try {
                return regionDisplay?.of(code) ?? ''
            } catch {
                return ''
            }
        })()
        if (long && long !== short) {
            out = out.split(long).join(short)
        }
    }
    // 老版本 ICU 的写法兜底
    out = out
        .split('香港特别行政区').join('中国香港')
        .split('澳门特别行政区').join('中国澳门')
        .split('台湾地区').join('台湾')
        .split('大韩民国').join('韩国')
        .split('美利坚合众国').join('美国')
        .split('新加坡共和国').join('新加坡')
        .split('澳大利亚联邦').join('澳大利亚')
        .split('阿拉伯联合酋长国').join('阿联酋')
    return out
}
