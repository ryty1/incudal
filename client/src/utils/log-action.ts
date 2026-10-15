/**
 * 日志操作（action）→ 可读文案映射
 *
 * 背景：logs 表的 action 字段存的是机器标识（如 port.add / instance.rebuild），
 * 早期前端直接把它显示出来（LogsView.vue 的 formatAction 注释写着"直接显示原始值"），
 * 对用户不可读。这里统一做映射，三个渲染点共用：
 *   - client/src/views/LogsView.vue            （面板 → 日志）
 *   - client/src/components/instance/InstanceLogsTab.vue（实例详情 → 日志）
 *
 * 约定：未收录的 action 原样返回，绝不留空白。
 */

type Lang = 'zh-CN' | 'en'

/** 中文（简体）。繁体回退到这里，技术词汇基本通用。 */
const ZH: Record<string, string> = {
  // ── 账号 / 安全 ──
  '2fa.enable': '启用两步验证',
  '2fa.setup': '设置两步验证',
  login_success: '登录成功',
  login_failed: '登录失败',
  logout: '退出登录',
  register_success: '注册成功',
  'profile.update': '更新个人资料',
  rate_limit_exceeded: '触发访问限流',
  suspicious_activity: '检测到可疑活动',
  'user.create': '创建用户',
  'user.delete': '删除用户',
  'user.reset_password': '重置用户密码',
  'user.role.update': '更新用户角色',
  'admin.detect_linked_accounts': '检测关联账号',
  'admin.adjust_hosting_balance': '调整托管余额',
  'balance.adjust': '调整余额',

  // ── 实例 ──
  'instance.create': '创建实例',
  'instance.admin_create': '后台创建实例',
  'instance.create_timeout': '实例创建超时',
  'instance.delete': '删除实例',
  'instance.batch_delete': '批量删除实例',
  'instance.user_destroy': '用户销毁实例',
  'instance.admin_delete_refund': '删除实例并退款',
  'instance.admin_delete_refund_db_only': '仅删除实例数据库记录',
  'instance.rename': '重命名实例',
  'instance.start': '启动实例',
  'instance.stop': '停止实例',
  'instance.restart': '重启实例',
  'instance.rebuild': '重装实例系统',
  'instance.recreate': '重建实例',
  'instance.renew': '续费实例',
  'instance.auto_renew': '实例自动续费',
  'instance.admin_extend': '后台延长实例',
  'instance.change_host': '迁移实例节点',
  'instance.update_config': '更新实例配置',
  'instance.update_quota': '更新实例配额',
  'instance.boost_processes': '提升进程数上限',
  'instance.enable_swap': '开启交换分区',
  'instance.disable_swap': '关闭交换分区',
  'instance.admin_update_price': '更新实例价格',
  'instance.admin_batch_update_price': '批量更新实例价格',

  // ── 端口映射 ──
  'port.add': '添加端口映射',
  'port.batch_add': '批量添加端口映射',
  'port.delete': '删除端口映射',

  // ── 节点（宿主机）──
  'host.create': '创建节点',
  'host.delete': '删除节点',
  'host.update': '更新节点设置',
  'host.verify': '验证节点',
  'host.recalculate_resources': '重算节点资源',
  'host.sync_instance_status': '同步节点实例状态',
  'host.image_policy': '更新节点镜像策略',
  'host.instance_create_for_user': '在节点上为用户创建实例',
  'host.regenerate_install': '重新生成节点安装命令',
  'host.update_instance_renewal_price': '更新节点实例续费价',
  'host.agent_install_command_generate': '生成节点安装命令',
  'host.agent_install_token_issue': '签发节点安装令牌',
  'host.agent_install_token_consume': '使用节点安装令牌',
  'host.ops.audit.scan': '节点运维安全审计',

  // ── 存储池 ──
  'storage.create': '创建存储池',
  'storage.delete': '删除存储池',
  'storage.update': '更新存储池',

  // ── 套餐 / 方案 ──
  'package.create': '创建套餐',
  'package.update': '更新套餐',
  'package.delete': '删除套餐',
  'package.release_quota': '释放套餐配额',
  'plan.create': '创建方案',
  'plan.update': '更新方案',
  'plan.sync_quota': '同步方案配额',

  // ── 优惠码 / 券 ──
  'admin.promo.create': '创建优惠码',
  'admin.promo.update': '更新优惠码',
  'admin.promo.delete': '删除优惠码',
  'admin.promo.restore': '恢复优惠码',
  'admin.promo.void': '作废优惠码',

  // ── 终端 / SSH 密钥 ──
  'terminal.connect': '连接终端',
  'terminal.disconnect': '断开终端',
  'terminal.saved_command.create': '创建终端快捷命令',
  'terminal.saved_command.update': '更新终端快捷命令',
  'terminal.saved_command.delete': '删除终端快捷命令',
  'ssh_key.add': '添加 SSH 密钥',
  'ssh_key.delete': '删除 SSH 密钥',
  'ssh_key.generate': '生成 SSH 密钥',

  // ── 邮件 / 通知 ──
  'smtp.test': '测试 SMTP 配置',
  'smtp.send_test': '发送测试邮件',
  'notification.add': '添加通知',
  'notification.delete': '删除通知',

  // ── 系统 / 机器人 ──
  'system.config_update': '更新系统配置',
  'bot_bridge.update': '更新机器人桥接设置',
  'bot_bridge.disable': '关闭机器人桥接',

  // ── 自定义初始化命令 ──
  'custom_init_command.create': '创建自定义初始化命令',
  'custom_init_command.update': '更新自定义初始化命令',
  'custom_init_command.delete': '删除自定义初始化命令',

  // ── 流量 / 转移 ──
  'traffic.reset': '重置流量',
  'transfer.create': '发起实例转移',
  'transfer.accept': '接受实例转移',

  // ── 一致性对账（面板自动任务）──
  'reconcile.resource': '对账：资源计数已校正',
  'reconcile.summary': '对账：一致性检查汇总',
  'reconcile.ghost_delete': '对账：清理幽灵容器（节点有·面板无）',
  'reconcile.create_failed': '对账：标记创建失败实例（面板有·节点无）',
  'reconcile.missing': '对账：标记缺失实例',
  'reconcile.legacy_device': '对账：清理旧版代理设备',

  // ── 兜底 ──
  create: '创建',
  update: '更新',
  delete: '删除',
}

/** 英文 */
const EN: Record<string, string> = {
  '2fa.enable': 'Enable 2FA',
  '2fa.setup': 'Set up 2FA',
  login_success: 'Signed in',
  login_failed: 'Sign-in failed',
  logout: 'Signed out',
  register_success: 'Registered',
  'profile.update': 'Update profile',
  rate_limit_exceeded: 'Rate limited',
  suspicious_activity: 'Suspicious activity detected',
  'user.create': 'Create user',
  'user.delete': 'Delete user',
  'user.reset_password': 'Reset user password',
  'user.role.update': 'Update user role',
  'admin.detect_linked_accounts': 'Detect linked accounts',
  'admin.adjust_hosting_balance': 'Adjust hosting balance',
  'balance.adjust': 'Adjust balance',

  'instance.create': 'Create instance',
  'instance.admin_create': 'Admin create instance',
  'instance.create_timeout': 'Instance creation timed out',
  'instance.delete': 'Delete instance',
  'instance.batch_delete': 'Batch delete instances',
  'instance.user_destroy': 'User destroyed instance',
  'instance.admin_delete_refund': 'Delete instance & refund',
  'instance.admin_delete_refund_db_only': 'Delete instance record only',
  'instance.rename': 'Rename instance',
  'instance.start': 'Start instance',
  'instance.stop': 'Stop instance',
  'instance.restart': 'Restart instance',
  'instance.rebuild': 'Reinstall instance',
  'instance.recreate': 'Recreate instance',
  'instance.renew': 'Renew instance',
  'instance.auto_renew': 'Auto-renew instance',
  'instance.admin_extend': 'Admin extend instance',
  'instance.change_host': 'Migrate instance host',
  'instance.update_config': 'Update instance config',
  'instance.update_quota': 'Update instance quota',
  'instance.boost_processes': 'Boost process limit',
  'instance.enable_swap': 'Enable swap',
  'instance.disable_swap': 'Disable swap',
  'instance.admin_update_price': 'Update instance price',
  'instance.admin_batch_update_price': 'Batch update instance prices',

  'port.add': 'Add port mapping',
  'port.batch_add': 'Batch add port mappings',
  'port.delete': 'Delete port mapping',

  'host.create': 'Create host',
  'host.delete': 'Delete host',
  'host.update': 'Update host settings',
  'host.verify': 'Verify host',
  'host.recalculate_resources': 'Recalculate host resources',
  'host.sync_instance_status': 'Sync instance status',
  'host.image_policy': 'Update host image policy',
  'host.instance_create_for_user': 'Create instance for user on host',
  'host.regenerate_install': 'Regenerate host install command',
  'host.update_instance_renewal_price': 'Update instance renewal price',
  'host.agent_install_command_generate': 'Generate host install command',
  'host.agent_install_token_issue': 'Issue host install token',
  'host.agent_install_token_consume': 'Consume host install token',
  'host.ops.audit.scan': 'Host ops security audit',

  'storage.create': 'Create storage pool',
  'storage.delete': 'Delete storage pool',
  'storage.update': 'Update storage pool',

  'package.create': 'Create package',
  'package.update': 'Update package',
  'package.delete': 'Delete package',
  'package.release_quota': 'Release package quota',
  'plan.create': 'Create plan',
  'plan.update': 'Update plan',
  'plan.sync_quota': 'Sync plan quota',

  'admin.promo.create': 'Create promo code',
  'admin.promo.update': 'Update promo code',
  'admin.promo.delete': 'Delete promo code',
  'admin.promo.restore': 'Restore promo code',
  'admin.promo.void': 'Void promo code',

  'terminal.connect': 'Connect terminal',
  'terminal.disconnect': 'Disconnect terminal',
  'terminal.saved_command.create': 'Create terminal snippet',
  'terminal.saved_command.update': 'Update terminal snippet',
  'terminal.saved_command.delete': 'Delete terminal snippet',
  'ssh_key.add': 'Add SSH key',
  'ssh_key.delete': 'Delete SSH key',
  'ssh_key.generate': 'Generate SSH key',

  'smtp.test': 'Test SMTP config',
  'smtp.send_test': 'Send test email',
  'notification.add': 'Add notification',
  'notification.delete': 'Delete notification',

  'system.config_update': 'Update system config',
  'bot_bridge.update': 'Update bot bridge settings',
  'bot_bridge.disable': 'Disable bot bridge',

  'custom_init_command.create': 'Create init command',
  'custom_init_command.update': 'Update init command',
  'custom_init_command.delete': 'Delete init command',

  'traffic.reset': 'Reset traffic',
  'transfer.create': 'Create transfer',
  'transfer.accept': 'Accept transfer',

  'reconcile.resource': 'Reconcile: resource counters fixed',
  'reconcile.summary': 'Reconcile: consistency check summary',
  'reconcile.ghost_delete': 'Reconcile: remove ghost container',
  'reconcile.missing': 'Reconcile: mark missing instance',
  'reconcile.legacy_device': 'Reconcile: convert legacy proxy device',

  create: 'Create',
  update: 'Update',
  delete: 'Delete',
}

/** 按 action 的前缀给个中文模块名，用于未收录动作的兜底展示 */
const MODULE_ZH: Record<string, string> = {
  instance: '实例',
  host: '节点',
  port: '端口',
  storage: '存储池',
  package: '套餐',
  plan: '方案',
  user: '用户',
  admin: '后台',
  system: '系统',
  bot_bridge: '机器人桥接',
  terminal: '终端',
  ssh_key: 'SSH 密钥',
  smtp: '邮件',
  notification: '通知',
  traffic: '流量',
  transfer: '转移',
  custom_init_command: '初始化命令',
  reconcile: '对账',
  balance: '余额',
  profile: '个人资料',
}

const MODULE_EN: Record<string, string> = {
  instance: 'Instance',
  host: 'Host',
  port: 'Port',
  storage: 'Storage',
  package: 'Package',
  plan: 'Plan',
  user: 'User',
  admin: 'Admin',
  system: 'System',
  bot_bridge: 'Bot bridge',
  terminal: 'Terminal',
  ssh_key: 'SSH key',
  smtp: 'Mail',
  notification: 'Notification',
  traffic: 'Traffic',
  transfer: 'Transfer',
  custom_init_command: 'Init command',
  reconcile: 'Reconcile',
  balance: 'Balance',
  profile: 'Profile',
}

function normalizeLocale(locale?: string): Lang {
  if (!locale) return 'zh-CN'
  return locale.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

/**
 * 把 logs.action 转成可读文案。
 * @param action 原始动作标识，如 'port.add'
 * @param locale 当前语言，如 'zh-CN' / 'zh-TW' / 'en'（zh-TW 回退到简体）
 */
export function formatLogAction(action: string, locale?: string): string {
  if (!action) return ''
  const lang = normalizeLocale(locale)
  const table = lang === 'en' ? EN : ZH
  if (table[action]) return table[action]

  // 未收录：退化成「模块 · 动作」，比裸的 key 强
  const dot = action.indexOf('.')
  if (dot > 0) {
    const mod = action.slice(0, dot)
    const rest = action.slice(dot + 1).replace(/[._]/g, ' ')
    const modName = (lang === 'en' ? MODULE_EN : MODULE_ZH)[mod]
    if (modName) return `${modName} · ${rest}`
  }
  // 再不行就原样返回，绝不留空
  return action
}

export default formatLogAction
