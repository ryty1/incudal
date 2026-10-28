/**
 * 节点状态变化 → 直接推送到「TGID 绑定」群里。
 *
 * 走的是「TG 管理 - 设置」里的 TGID 绑定三项配置（开关 / bot token / 群 chat id），
 * 不依赖外部机器人的 /api/bot/hosts/events 轮询，机器人挂了也能收到。
 */

import { getTgBindSettings } from '../lib/bot-bridge-config.js'
import * as db from '../db/index.js'

export type HostAlertStatus = 'online' | 'offline' | 'abnormal'

const TITLES: Record<HostAlertStatus, string> = {
    online: '🟢 节点恢复在线',
    offline: '🔴 节点离线',
    abnormal: '🟠 节点异常（端口通但 Incus API 不响应）'
}

function escapeHtml(input: string): string {
    return String(input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

/** 从 Incus 地址里取主机名，作为没配 nat_public_ip 时的兜底 */
function hostFromUrl(url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return ''
    }
}

/**
 * 通知里的 IP 脱敏：IPv4 保留前两段，IPv6 保留前两组。
 * 群里只需要能对上号，不需要完整地址。
 */
export function maskIp(ip: string): string {
    const value = (ip || '').trim().replace(/^\[|\]$/g, '')
    if (!value) return ''
    if (value.includes(':')) {
        const groups = value.split(':').filter(Boolean)
        return groups.length >= 2 ? `${groups[0]}:${groups[1]}:***:***` : '***'
    }
    const parts = value.split('.')
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.***.***`
    return '***'
}

function formatTime(): string {
    try {
        return new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        })
    } catch {
        return new Date().toISOString()
    }
}

export interface HostAlertHost {
    id: number
    name: string
    location?: string | null
    url?: string | null
    nat_public_ip?: string | null
}

/**
 * 推送一条节点状态消息。配置不全 / 推送失败都只记日志，不抛异常，
 * 避免影响状态检查主流程。
 */
export async function notifyHostStatusChange(status: HostAlertStatus, host: HostAlertHost): Promise<void> {
    try {
        const cfg = await getTgBindSettings()
        if (!cfg.available) {
            console.log(`[HostAlert] TGID 绑定未启用或配置不全，跳过 ${host.name} → ${status}`)
            return
        }

        let url = host.url || ''
        let natIp = host.nat_public_ip || ''
        if ((!url || !natIp) && host.id) {
            try {
                const row = await db.getHostById(host.id)
                if (row) {
                    url = url || row.url || ''
                    natIp = natIp || (row.nat_public_ip || '')
                }
            } catch { /* 读库失败就用调用方传进来的值 */ }
        }

        const ip = natIp.trim() || hostFromUrl(url)
        const lines = [
            `<b>${TITLES[status]}</b>`,
            '',
            `节点：${escapeHtml(host.name)}`,
            host.location ? `位置：${escapeHtml(host.location)}` : '',
            ip ? `IP：<code>${escapeHtml(maskIp(ip))}</code>` : '',
            `时间：${formatTime()}`
        ].filter(Boolean)

        const response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: cfg.groupChatId,
                text: lines.join('\n'),
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        })

        const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null
        if (!response.ok || !body?.ok) {
            console.error(`[HostAlert] 推送到群失败(${response.status}): ${body?.description || 'unknown'}`)
            return
        }
        console.log(`[HostAlert] 已推送：${host.name} → ${status}`)
    } catch (error) {
        console.error('[HostAlert] 推送异常:', error instanceof Error ? error.message : error)
    }
}
