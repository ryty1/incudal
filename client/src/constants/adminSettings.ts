export type SystemSettingsSectionKey = 'access' | 'hosting' | 'brand' | 'security' | 'mail' | 'tickets' | 'popup'

export interface SystemSettingsNavigationItem {
  key: SystemSettingsSectionKey | 'telegram'
  path: string
  labelKey: string
  descriptionKey?: string
}

export const systemSettingsSections: Array<SystemSettingsNavigationItem & { key: SystemSettingsSectionKey, descriptionKey: string }> = [
  {
    key: 'access',
    path: '/admin/settings/access',
    labelKey: 'admin.system.sections.access.title',
    descriptionKey: 'admin.system.sections.access.description'
  },
  {
    key: 'hosting',
    path: '/admin/settings/hosting',
    labelKey: 'admin.system.sections.hosting.title',
    descriptionKey: 'admin.system.sections.hosting.description'
  },
  {
    key: 'brand',
    path: '/admin/settings/brand',
    labelKey: 'admin.system.sections.brand.title',
    descriptionKey: 'admin.system.sections.brand.description'
  },
  {
    key: 'security',
    path: '/admin/settings/security',
    labelKey: 'admin.system.sections.security.title',
    descriptionKey: 'admin.system.sections.security.description'
  },
  {
    key: 'mail',
    path: '/admin/settings/mail',
    labelKey: 'admin.system.sections.mail.title',
    descriptionKey: 'admin.system.sections.mail.description'
  },
  {
    key: 'tickets',
    path: '/admin/settings/tickets',
    labelKey: 'admin.system.sections.tickets.title',
    descriptionKey: 'admin.system.sections.tickets.description'
  },
  {
    key: 'popup',
    path: '/admin/settings/popup-announcement',
    labelKey: 'admin.system.tabs.popupAnnouncement',
    descriptionKey: 'admin.system.popupAnnouncement.description'
  }
]

// Telegram 设置已并入「TG管理」页面（机器人桥接页里的「TG 设置」标签），
// 系统设置里不再单独出卡片。路由 /admin/settings/telegram 保留，老书签仍可直接访问。
export const systemSettingsNavigationItems: SystemSettingsNavigationItem[] = [
  ...systemSettingsSections
]
