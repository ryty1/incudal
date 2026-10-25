/**
 * 日志内容（logs.content）汉化
 *
 * 背景：logs.content 是服务端 createLog() 写入的英文原文（如
 * `Restarted instance "web-1" [host: HK-1]`），前端直接显示。
 * 历史日志已经存成英文，改服务端文案也追不回来，所以在渲染层做翻译：
 * 一份规则表同时覆盖新旧日志。
 *
 * 策略：
 *   1. 先用整句正则规则匹配（覆盖高频动作，保留引号里的名称/数字）
 *   2. 没命中再用短语字典做替换（保证任何英文句子都有中文，不会原样漏出）
 *   3. 已经是中文的（服务端部分文案就是中文）原样返回
 */

type Lang = 'zh' | 'en'

type Rule = [RegExp, string | ((...args: any[]) => string)]

const RULES: Rule[] = [
  // ── 实例生命周期 ──
  [/^Queued (\w+) task for instance "(.+?)"(?: on host "(.+?)")?(?: with image (.+))?$/i,
    (_m, _act, _name, _host, _img) => `已排队${actCn(_act)}任务：实例 "${_name}"${_host ? `，节点 "${_host}"` : ''}${_img ? `，镜像 ${_img}` : ''}`],
  [/^Failed to (\w+) instance "(.+?)":\s*(.+)$/i, (_m, _a, _n, _e) => `${actCn(_a)}实例 "${_n}" 失败：${_e}`],
  [/^Failed to (\w+) instance "(.+?)"$/i, (_m, _a, _n) => `${actCn(_a)}实例 "${_n}" 失败`],
  [/^Restarted instance "(.+?)"$/i, '重启实例 "$1"'],
  [/^Started instance "(.+?)"$/i, '启动实例 "$1"'],
  [/^Stopped instance "(.+?)"$/i, '停止实例 "$1"'],
  [/^Suspended instance "(.+?)"/i, '封停实例 "$1"'],
  [/^Unsuspended instance "(.+?)"$/i, '解封实例 "$1"'],
  [/^Deleted instance "(.+?)"(.*)$/i, '删除实例 "$1"$2'],
  [/^Created instance "(.+?)"(.*)$/i, '创建实例 "$1"$2'],
  [/^Renamed instance from "(.+?)" to "(.+?)"$/i, '实例重命名："$1" → "$2"'],
  [/^Restored instance "(.+?)" to snapshot "(.+?)"(.*)$/i, '实例 "$1" 已恢复快照 "$2"$3'],
  [/^Migrated instance "(.+?)" from host "(.+?)" to "(.+?)"$/i, '迁移实例 "$1"："$2" → "$3"'],
  [/^Changed plan for instance "(.+?)": (.+?) → (.+)$/i, '变更实例 "$1" 套餐：$2 → $3'],
  [/^(Enabled|Disabled) auto-renew for instance "(.+?)"$/i,
    (_m, _s, _n) => `${_s.toLowerCase() === 'enabled' ? '开启' : '关闭'}自动续费：实例 "${_n}"`],
  [/^Renewed instance "(.+?)" for (\d+) month\(s\), amount: (.+)$/i, '续费实例 "$1" $2 个月，金额 $3'],
  [/^Updated instance "(.+?)" quota: (.+)$/i, '更新实例 "$1" 配额：$2'],
  [/^Updated instance "(.+?)" config: (.+)$/i, '更新实例 "$1" 配置：$2'],
  [/^Failed to update instance "(.+?)" config: (.+)$/i, '更新实例 "$1" 配置失败：$2'],
  [/^Enabled SWAP for instance "(.+?)" \((.+?)MB\)$/i, '开启 SWAP：实例 "$1"（$2MB）'],
  [/^Disabled SWAP for instance "(.+?)"$/i, '关闭 SWAP：实例 "$1"'],
  [/^Boosted process limit for instance "(.+?)" to (.+)$/i, '提升进程数上限：实例 "$1" → $2'],
  [/^Manually marked cloud-init as completed for instance "(.+?)"$/i, '手动标记 cloud-init 完成：实例 "$1"'],
  [/^Reassigned IPv6 for instance "(.+?)": (.+?) → (.+)$/i, '重新分配 IPv6：实例 "$1" $2 → $3'],
  [/^Reset instance "(.+?)" traffic without charge$/i, '重置实例 "$1" 流量（免费）'],
  [/^Reset instance "(.+?)" traffic with charge (.+)$/i, '重置实例 "$1" 流量（扣费 $2）'],
  [/^Cancelled (\w+) task #(\d+) for instance #(\d+)$/i, '取消任务：$1 #$2（实例 #$3）'],
  [/^Batch (deleted|suspended|unsuspended|destroyed) instance "(.+?)"(?: on host "(.+?)")?$/i,
    (_m, _a, _n, _h) => `批量${actCn(_a)}实例 "${_n}"${_h ? `（节点 "${_h}"）` : ''}`],
  [/^Batch (deleted|suspended|unsuspended) (\d+) instances?$/i, (_m, _a, _c) => `批量${actCn(_a)} ${_c} 个实例`],
  [/^Batch renewed (\d+) instances?, amount: (.+)$/i, '批量续费 $1 个实例，金额 $2'],
  [/^Batch updated config for (\d+) instances?: (.+)$/i, '批量更新 $1 个实例配置：$2'],
  [/^Admin created paid instance "(.+?)" for user (\S+) \(Package: (.+?), Plan: (.+?), Charged: (.+?)\)$/i,
    (_m, _n, _u, _pkg, _plan, _ch) => `管理员开通付费实例 "${_n}"：用户 ${_u}（套餐：${_pkg}，方案：${_plan}，收费：${_ch.toLowerCase().includes('free first month') ? '首月免费' : _ch}）`],
  [/^Admin created paid instance "(.+?)" for user (\S+)(.*)$/i, (_m, _n, _u, _r) => `管理员开通付费实例 "${_n}"：用户 ${_u}${_r}`],
  [/^Batch extended (\d+) paid instances on host "(.+?)" by (\d+) days$/i, '批量延长 $1 个付费实例（节点 "$2"）+$3 天'],

  // ── 端口映射 ──
  [/^Added port mapping for instance "(.+?)"(.*)$/i, '新增端口映射：实例 "$1"$2'],
  [/^Deleted port mapping for instance "(.+?)"(.*)$/i, '删除端口映射：实例 "$1"$2'],
  [/^Batch added (\d+) port mappings for instance "(.+?)"(.*)$/i, '批量新增 $1 个端口映射：实例 "$2"$3'],
  [/^Failed to (add|delete|batch add) port mapping[s]?: (.+)$/i, (_m, _a, _b) => `${actCn(_a)}端口映射失败：${_b}`],

  // ── 快照 / 备份 ──
  [/^Created snapshot "(.+?)" for instance "(.+?)"(.*)$/i, '创建快照 "$1"：实例 "$2"$3'],
  [/^Deleted snapshot "(.+?)" of instance "(.+?)"(.*)$/i, '删除快照 "$1"：实例 "$2"$3'],
  [/^Failed to (create|delete|restore) snapshot: (.+)$/i, (_m, _a, _b) => `${actCn(_a)}快照失败：${_b}`],
  [/^Created backup "(.+?)" for instance "(.+?)"(.*)$/i, '创建备份 "$1"：实例 "$2"$3'],
  [/^Deleted backup "(.+?)" of instance "(.+?)"(.*)$/i, '删除备份 "$1"：实例 "$2"$3'],
  [/^Failed to (create|delete) backup(?: for instance "(.+?)")?: (.+)$/i,
    (_m, _a, _inst, _b) => `${actCn(_a)}备份失败${_inst ? `（实例 "${_inst}"）` : ''}：${_b}`],
  [/^Queued restore task for instance "(.+?)" from backup "(.+?)"$/i, '已排队恢复任务：实例 "$1"，备份 "$2"'],
  [/^Rolled back restore task for instance "(.+?)"$/i, '已回滚恢复任务：实例 "$1"'],
  [/^Cancelled restore task for instance "(.+?)"$/i, '已取消恢复任务：实例 "$1"'],
  [/^Queued backup upload for "(.+?)" to "(.+?)"$/i, '已排队上传备份 "$1" → "$2"'],
  [/^Cancelled backup upload task$/i, '已取消备份上传任务'],
  [/^Generated export task for backup "(.+?)" of instance "(.+?)"$/i, '生成导出任务：备份 "$1"（实例 "$2"）'],

  // ── 节点 ──
  [/^Created host "(.+?)"(.*)$/i, '创建节点 "$1"$2'],
  [/^Updated host "(.+?)"(.*)$/i, '更新节点 "$1"$2'],
  [/^Deleted host "(.+?)"(.*)$/i, '删除节点 "$1"$2'],
  [/^Verified and connected host "(.+?)"(.*)$/i, '节点验证并连接成功 "$1"$2'],
  [/^Regenerated install command for host "(.+?)"$/i, '重新生成安装命令：节点 "$1"'],
  [/^(Enabled|Disabled) maintenance mode for host "(.+?)"$/i,
    (_m, _s, _n) => `${_s.toLowerCase() === 'enabled' ? '开启' : '关闭'}维护模式：节点 "${_n}"`],
  [/^Synced (\d+) instances on host "(.+?)", (\d+) status changed, (\d+) IPv4 changed, (\d+) IPv6 changed$/i,
    '同步节点 "$2" 的 $1 个实例：状态变更 $3，IPv4 变更 $4，IPv6 变更 $5'],
  [/^Recalculated resources for host "(.+?)": (.*)$/i, '重新计算节点 "$1" 资源：$2'],
  [/^Migrated instance .*$/i, '迁移实例'],
  [/^Take over hosted host #(\d+) from user #(\d+): (.*)$/i, '接管托管节点 #$1（原属用户 #$2）：$3'],
  [/^Linked existing storage pool "(.+?)" \((.+?)\) on host "(.+?)"$/i, '关联存储池 "$1"（$2）：节点 "$3"'],
  [/^Imported existing (.+?) storage "(.+?)" as pool "(.+?)" on host "(.+?)"$/i, '导入存储 "$2" 为存储池 "$3"（节点 "$4"）'],
  [/^Created storage pool "(.+?)" \((.+?)\) on host "(.+?)"$/i, '创建存储池 "$1"（$2）：节点 "$3"'],
  [/^Deleted storage pool "(.+?)" from host "(.+?)"$/i, '删除存储池 "$1"：节点 "$2"'],
  [/^Updated storage pool "(.+?)" on host "(.+?)"$/i, '更新存储池 "$1"：节点 "$2"'],
  [/^(Generated|Reset) Caddy credentials for host "(.+?)"$/i,
    (_m, _a, _h) => `${_a.toLowerCase() === 'generated' ? '生成' : '重置'} Caddy 凭据：节点 "${_h}"`],
  [/^Confirmed Caddy installation for host "(.+?)"$/i, '确认 Caddy 安装：节点 "$1"'],
  [/^(Created|Updated|Deleted) (\w+ )?audit rule "(.+?)" on host "(.+?)"$/i,
    (_m, _a, _scope, _n, _h) => `${actCn(_a)}${_scope ? ' ' + _scope.trim() + ' ' : ''}审计规则 "$n"：节点 "${_h}"`],
  [/^(Created|Disabled) audit (rule|whitelist)(.*)$/i, (_m, _a, _b, _c) => `${actCn(_a)}审计${_b === 'rule' ? '规则' : '白名单'}${_c}`],
  [/^Ran manual audit scan for instance "(.+?)" on host "(.+?)" \((\d+) finding\(s\)\)$/i,
    '手动审计扫描：实例 "$1"（节点 "$2"），发现 $3 项'],
  [/^Sent SIG(.+?) to PID (\d+) in instance "(.+?)" on host "(.+?)"\. Reason: (.+)$/i,
    '发送 SIG$1 给 PID $2：实例 "$3"（节点 "$4"），原因：$5'],
  [/^Failed to send SIG(.+?) to PID (\d+) in instance "(.+?)" on host "(.+?)": (.+)$/i,
    '发送 SIG$1 给 PID $2 失败：实例 "$3"（节点 "$4"）：$5'],
  [/^Audit scan unavailable for instance "(.+?)" on host "(.+?)": (.+)$/i, '审计扫描不可用：实例 "$1"（节点 "$2"）：$3'],
  [/^(Updated|Reset) builtin audit rule override "(.+?)" on host "(.+?)"$/i,
    (_m, _a, _r, _h) => `${actCn(_a)}内置审计规则覆盖 "$r"：节点 "${_h}"`],
  [/^Queued host change for instance "(.+?)" from host "(.+?)" to "(.+?)"$/i, '已排队迁移：实例 "$1"，"$2" → "$3"'],

  // ── 用户 / 余额 ──
  [/^Created user "(.+?)"/i, '创建用户 "$1"'],
  [/^Deleted user (.+)$/i, '删除用户 $1'],
  [/^Blocked user "(.+?)" \(#(\d+)\)$/i, '封禁用户 "$1"（#$2）'],
  [/^Unblocked user #(\d+)$/i, '解封用户 #$1'],
  [/^Adjusted balance for user (.+?): (.+?), reason: (.+)$/i, '调整余额：用户 $1，$2，原因：$3'],
  [/^Gifted (.+?) to user (.+)$/i, '赠送 $1：用户 $2'],
  [/^Transferred (.+?) to user (.+?), fee (.+?), transferNo (.+)$/i, '转账 $1 给 $2，手续费 $3，流水号 $4'],
  [/^Withdrawal to balance: amount=(.+?), actualAmount=(.+)$/i, '提现到余额：金额 $1，实到 $2'],
  [/^Admin unlinked Telegram binding for user #(\d+) \((.+?)\)$/i, '管理员解绑 Telegram：用户 #$1（$2）'],

  // ── 套餐 / 方案 ──
  [/^Created package "(.+?)"(.*)$/i, '创建套餐 "$1"$2'],
  [/^Updated package "(.+?)"(.*)$/i, '更新套餐 "$1"$2'],
  [/^Deleted package "(.+?)"(.*)$/i, '删除套餐 "$1"$2'],
  [/^Created plan "(.+?)" for package "(.+?)"$/i, '创建方案 "$1"：套餐 "$2"'],
  [/^Updated plan "(.+?)" for package "(.+?)"$/i, '更新方案 "$1"：套餐 "$2"'],
  [/^Deleted plan "(.+?)" from package "(.+?)"$/i, '删除方案 "$1"：套餐 "$2"'],
  [/^Released quota for package "(.+?)": (.*)$/i, '释放套餐 "$1" 配额：$2'],
  [/^Synced quota to (\d+) instance\(s\) for plan "(.+?)"$/i, '同步配额到 $1 个实例：方案 "$2"'],

  // ── 充值 / 卡密 ──
  [/^Recharge completed: order (.+?), amount (.+?), tradeNo: (.+)$/i, '充值完成：订单 $1，金额 $2，交易号 $3'],
  [/^Recharge completed via verify API: order (.+?), amount (.+?), tradeNo: (.+)$/i, '充值完成（主动查询）：订单 $1，金额 $2，交易号 $3'],
  [/^Recharge card redeemed: card (.+?), amount (.+?), order (.+)$/i, '卡密兑换：卡号 $1，金额 $2，订单 $3'],
  [/^Admin generated recharge card batch (.+?), count (\d+), amount (.+)$/i, '管理员生成充值卡批次 $1，$2 张，面额 $3'],
  [/^Admin exported recharge cards, selected (\d+), exported (\d+)$/i, '管理员导出充值卡：选中 $1，导出 $2'],
  [/^Admin bulk deleted recharge cards, selected (\d+), deleted (\d+), skippedUsed (\d+), notFound (\d+)$/i,
    '管理员批量删除充值卡：选中 $1，删除 $2，已用跳过 $3，不存在 $4'],
  [/^Admin deleted unused recharge card (.+)$/i, '管理员删除未使用充值卡 $1'],
  [/^Admin manually completed recharge order (.+?) for user (.+?), amount: (.+)$/i, '管理员手动完成充值：订单 $1，用户 $2，金额 $3'],
  [/^Admin marked recharge order (.+?) as failed: (.+)$/i, '管理员标记充值失败：订单 $1，原因 $2'],
  [/^Underpaid recharge rejected: order (.+?), expected (.+?), actual (.+)$/i, '充值金额不足已拒绝：订单 $1，应付 $2，实付 $3'],
  [/^Amount mismatch rejected: order (.+?), expected (.+?), actual (.+)$/i, '充值金额不匹配已拒绝：订单 $1，应付 $2，实付 $3'],
  [/^Created (\d+) redeem codes for host "(.+?)"(.*)$/i, '为节点 "$2" 生成 $1 个卡密$3'],
  [/^Created redeem code for host "(.+?)"(.*)$/i, '为节点 "$1" 生成卡密$2'],
  [/^Failed to create redeem code for host \(ID: (\d+)\): (.+)$/i, '生成卡密失败（节点 #$1）：$2'],

  // ── 推广 ──
  [/^Created AFF code "(.+?)"/i, '创建推广码 "$1"'],
  [/^Deleted AFF code (.+)$/i, '删除推广码 $1'],
  [/^AFF balance converted: (.+)$/i, '推广佣金已兑换：$1'],
  [/^Approved AFF convert request #(\d+)$/i, '通过推广佣金兑换申请 #$1'],
  [/^Rejected AFF convert request #(\d+): (.+)$/i, '拒绝推广佣金兑换申请 #$1：$2'],
  [/^Applied AFF code "(.+?)" to instance "(.+?)"(.*)$/i, '应用推广码 "$1"：实例 "$2"$3'],

  // ── 抽奖 / 徽章 ──
  [/^(Created|Updated|Deleted) lottery "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}抽奖 "$n"${_r}`],
  [/^(Created|Updated|Deleted) prize "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}奖品 "$n"${_r}`],
  [/^Added prize "(.+?)" to lottery "(.+?)"$/i, '添加奖品 "$1"：抽奖 "$2"'],
  [/^Updated notification config for lottery "(.+?)"$/i, '更新抽奖通知配置："$1"'],
  [/^(Created|Updated|Deleted) badge(?: series)? "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}徽章 "$n"${_r}`],

  // ── 帮助 / 站点 / 工单 ──
  [/^Updated help category config \((\d+) categories\)$/i, '更新帮助分类配置（$1 个分类）'],
  [/^(Created|Updated|Deleted) help article "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}帮助文章 "${_n}"${_r}`],
  [/^(Created|Deleted|Activated|Refreshed|Updated) proxy site "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}代理站点 "${_n}"${_r}`],
  [/^Failed to refresh proxy site "(.+?)": (.+)$/i, '刷新代理站点 "$1" 失败：$2'],
  [/^(Enabled|Disabled) proxy site "(.+?)"$/i, (_m, _s, _n) => `${_s.toLowerCase() === 'enabled' ? '启用' : '停用'}代理站点 "${_n}"`],

  // ── 存储 / 系统 ──
  [/^(Created|Updated|Deleted) storage config "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}存储配置 "${_n}"${_r}`],
  [/^Updated (\d+) system configurations$/i, '更新 $1 项系统配置'],
  [/^SMTP connection test successful$/i, 'SMTP 连接测试成功'],
  [/^SMTP connection test failed: (.+)$/i, 'SMTP 连接测试失败：$1'],
  [/^Test email sent to (.+)$/i, '测试邮件已发送至 $1'],
  [/^Failed to send test email to (.+?): (.+)$/i, '发送测试邮件失败（$1）：$2'],
  [/^Created global TG channel "(.+?)"(.*)$/i, '创建全局 TG 频道 "$1"$2'],
  [/^(Updated|Deleted) global TG channel "(.+?)"(.*)$/i, (_m, _a, _n, _r) => `${actCn(_a)}全局 TG 频道 "${_n}"${_r}`],
  [/^Daily check-in is temporarily disabled$/i, '每日签到已暂停'],
  [/^Terminal (connected|disconnected|connection failed)(.*)$/i,
    (_m, _s, _rest) => `终端${_s.toLowerCase() === 'connected' ? '已连接' : _s.toLowerCase() === 'disconnected' ? '已断开' : '连接失败'}${_rest}`],
  [/^(Created|Updated|Deleted) terminal saved command(.*)$/i, (_m, _a, _r) => `${actCn(_a)}终端保存的命令${_r}`],

  // ── 账号安全 ──
  [/^Started 2FA setup$/i, '开始设置两步验证'],
  [/^Enabled two-factor authentication$/i, '启用两步验证'],
  [/^Disabled two-factor authentication$/i, '关闭两步验证'],
  [/^Regenerated 2FA recovery codes$/i, '重新生成两步验证恢复码'],
  [/^2FA disabled due to password reset$/i, '因重置密码关闭了两步验证'],
  [/^Added SSH key "(.+?)"(.*)$/i, '添加 SSH 密钥 "$1"$2'],
  [/^Generated SSH key "(.+?)"(.*)$/i, '生成 SSH 密钥 "$1"$2'],
  [/^Deleted SSH key "(.+?)"(.*)$/i, '删除 SSH 密钥 "$1"$2'],
  [/^Added IP (.+?) to instance "(.+?)"$/i, '添加 IP $1：实例 "$2"'],
  [/^Removed IP (.+?) from instance "(.+?)"$/i, '移除 IP $1：实例 "$2"'],
  [/^Set custom IPv6 (.+?) \(was (.+?)\) for instance "(.+?)"$/i, '设置自定义 IPv6 $1（原 $2）：实例 "$3"'],
  [/^Allocated IPv6 subnet (.+?) to instance "(.+?)"$/i, '分配 IPv6 子网 $1：实例 "$2"'],
  [/^Removed IPv6 subnet (.+?) from instance "(.+?)"$/i, '移除 IPv6 子网 $1：实例 "$2"'],
  [/^Updated renewal price for instance "(.+?)" \(ID: (\d+)\): (.+?) -> (.+)$/i,
    '更新实例 "$1" 续费价（#$2）：$3 → $4'],
  [/^Applied (.+?) to instance (.+)$/i, '应用 $1：实例 $2'],
  [/^Failed to apply resource to instance (.+?): (.+)$/i, '应用资源失败（实例 $1）：$2'],
]

/** 动作词 → 中文（用于规则里的动态拼接） */
function actCn(a: string): string {
  const map: Record<string, string> = {
    start: '启动', stop: '停止', restart: '重启', rebuild: '重装', recreate: '重建',
    delete: '删除', create: '创建', update: '更新', destroy: '销毁', renew: '续费',
    suspend: '封停', unsuspend: '解封', clone: '克隆', migrate: '迁移', config: '修改',
    add: '新增', batch_add: '批量新增', 'batch add': '批量新增', reset: '重置',
    restore: '恢复', rollback: '回滚', export: '导出', upload: '上传', extend: '延长',
    upgrade: '升级', downgrade: '降级', change: '变更', rename: '重命名', apply: '应用',
    created: '创建', updated: '更新', deleted: '删除', added: '新增', removed: '移除',
    suspended: '封停', unsuspended: '解封', renewed: '续费', extended: '延长',
    destroyed: '销毁', restored: '恢复', enabled: '启用', disabled: '关闭',
    'batch delete': '批量删除', 'batch destroy': '批量销毁',
  }
  return map[a.toLowerCase()] || a
}

/** 兜底短语表：整句规则没命中时按顺序替换（长的放前面） */
const PHRASES: Array<[RegExp, string]> = [
  [/\bFailed to\b/gi, '失败：'],
  [/\bQueued\b/gi, '已排队'],
  [/\bCreated\b/gi, '创建'],
  [/\bUpdated\b/gi, '更新'],
  [/\bDeleted\b/gi, '删除'],
  [/\bRestored\b/gi, '恢复'],
  [/\bEnabled\b/gi, '启用'],
  [/\bDisabled\b/gi, '关闭'],
  [/\bBatch\b/gi, '批量'],
  [/\bAdmin\b/gi, '管理员'],
  [/\binstance\b/gi, '实例'],
  [/\bhost\b/gi, '节点'],
  [/\buser\b/gi, '用户'],
  [/\bpackage\b/gi, '套餐'],
  [/\bplan\b/gi, '方案'],
  [/\bsnapshot\b/gi, '快照'],
  [/\bbackup\b/gi, '备份'],
  [/\bstorage\b/gi, '存储'],
  [/\bpool\b/gi, '池'],
  [/\bport mapping\b/gi, '端口映射'],
  [/\bquota\b/gi, '配额'],
  [/\bconfig\b/gi, '配置'],
  [/\bsite\b/gi, '站点'],
  [/\bbadge\b/gi, '徽章'],
  [/\bseries\b/gi, '系列'],
  [/\blottery\b/gi, '抽奖'],
  [/\bprize\b/gi, '奖品'],
  [/\bticket\b/gi, '工单'],
  [/\barticle\b/gi, '文章'],
  [/\bredeem code\b/gi, '卡密'],
  [/\brecharge card\b/gi, '充值卡'],
  [/\brecharge\b/gi, '充值'],
  [/\bbalance\b/gi, '余额'],
  [/\btask\b/gi, '任务'],
  [/\btraffic\b/gi, '流量'],
  [/\bmaintenance mode\b/gi, '维护模式'],
  [/\binstall command\b/gi, '安装命令'],
  [/\baudit rule\b/gi, '审计规则'],
  [/\bwhitelist\b/gi, '白名单'],
  [/\bsubnet\b/gi, '子网'],
  [/\bwith image\b/gi, '镜像'],
  [/\breason:\s*/gi, '原因：'],
  [/\bamount:\s*/gi, '金额：'],
  [/\bfee\b/gi, '手续费'],
  [/\bsuccessful(ly)?\b/gi, '成功'],
  [/\bfailed\b/gi, '失败'],
  [/\bunknown\b/gi, '未知'],
]

/** 方括号明细里的键名（[host: x, CPU: 15%, ...]） */
const DETAIL_KEYS: Array<[RegExp, string]> = [
  [/\bhost:\s*/gi, '节点: '],
  [/\buser:\s*/gi, '用户: '],
  [/\bports?:\s*/gi, '端口: '],
  [/\bimage:\s*/gi, '镜像: '],
  [/\breason:\s*/gi, '原因: '],
  [/\bamount:\s*/gi, '金额: '],
  [/\bcount:\s*/gi, '数量: '],
  [/\bremark:\s*/gi, '备注: '],
  [/\bfingerprint:\s*/gi, '指纹: '],
  [/\barch:\s*/gi, '架构: '],
  [/\bcores?\b/gi, '核'],
  [/\bcpuMax\b/gi, 'CPU 上限'],
  [/\bmemoryMax\b/gi, '内存上限'],
  [/\bdiskMax\b/gi, '硬盘上限'],
  [/\bcpuMin\b/gi, 'CPU 下限'],
  [/\bmemoryMin\b/gi, '内存下限'],
  [/\bdiskMin\b/gi, '硬盘下限'],
  [/\binstanceType\b/gi, '实例类型'],
  [/\bactive\b/gi, '启用'],
  [/\bhosts\b/gi, '节点'],
  [/\bCPU:\s*/gi, 'CPU: '],
  [/\bMemory:\s*/gi, '内存: '],
  [/\bDisk:\s*/gi, '硬盘: '],
  [/\bIPv4:\s*/gi, 'IPv4: '],
  [/\bIPv6:\s*/gi, 'IPv6: '],
  [/\bnetwork:\s*/gi, '网络: '],
  [/\btype:\s*/gi, '类型: '],
  [/\bmode:\s*/gi, '模式: '],
  [/\bsession:\s*/gi, '会话: '],
  [/\bPackage:\s*/gi, '套餐: '],
  [/\bPlan:\s*/gi, '方案: '],
  [/\bCharged:\s*/gi, '收费: '],
  [/\bfee:\s*/gi, '手续费: '],
  [/\btradeNo:\s*/gi, '交易号: '],
  [/\border:\s*/gi, '订单: '],
  [/\bstatus:\s*/gi, '状态: '],
  [/\bip:\s*/gi, 'IP: '],
]

/** 「| key: value」形式的明细键名 */
const KV_PHRASES: Array<[RegExp, string]> = [
  [/\|\s*instance:\s*/gi, '| 实例: '],
  [/\|\s*host:\s*/gi, '| 节点: '],
  [/\|\s*user:\s*/gi, '| 用户: '],
  [/\|\s*type:\s*/gi, '| 类型: '],
  [/\|\s*mode:\s*/gi, '| 模式: '],
  [/\|\s*ip:\s*/gi, '| IP: '],
  [/\|\s*session:\s*/gi, '| 会话: '],
]

/** 判断是否已经基本是中文（服务端有些文案本来就是中文） */
function isChinese(text: string): boolean {
  const zh = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const en = (text.match(/[A-Za-z]/g) || []).length
  return zh > en
}

export function formatLogContent(content: string, locale?: string): string {
  if (!content) return ''
  const lang: Lang = locale && locale.toLowerCase().startsWith('en') ? 'en' : 'zh'
  if (lang === 'en') return content
  if (isChinese(content)) return content

  const raw = content.trim()

  // 0) 先把结尾的 [host: xxx, user: 12] 这类明细拆出来，翻译键名后原样带回，
  //    否则整句规则会因为结尾多一段方括号而匹配不上
  let main = raw
  let detail = ''
  const dm = raw.match(/^(.*?)\s*(\[[^\]]*\])\s*$/)
  if (dm) {
    main = dm[1]
    detail = dm[2]
    for (const [re, rep] of DETAIL_KEYS) detail = detail.replace(re, rep)
  }

  const apply = (text: string): string => {
    for (const [re, rep] of RULES) {
      const m = re.exec(text)
      if (!m) continue
      if (typeof rep === 'function') {
        try { return rep(...m) } catch { break }
      }
      return text.replace(re, rep)
    }
    let out = text
    for (const [re, rep] of PHRASES) out = out.replace(re, rep)
    return out
  }

  const translated = apply(main)
  let out = detail ? `${translated} ${detail}` : translated
  // 终端日志这类「a | b | c」的键值对，键名统一翻掉
  for (const [re, rep] of KV_PHRASES) out = out.replace(re, rep)
  return out
}

export default formatLogContent
