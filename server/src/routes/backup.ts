/**
 * 数据备份路由（管理员）
 *
 * 面板「数据备份」设置卡的后端。所有操作都通过宿主机上的
 * /root/incudal-backup.sh 与 /root/incudal-restore.sh 完成 ——
 * 面板本身不直接连数据库做备份，避免把敏感操作放进应用进程。
 *
 * 安全：
 *  - 全部端点 requiresAdmin
 *  - 导入属于高危操作，强制要求 body.confirm === 'RESTORE' 才执行
 *  - 只允许操作 /root/incudal-backups/ 下的文件（防路径穿越）
 */
import type { FastifyInstance } from 'fastify'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync, createReadStream, accessSync, constants } from 'fs'
import { join, basename, dirname } from 'path'
import { apiError, ErrorCode } from '../lib/errors.js'
import { logAdminAction } from '../lib/security.js'

const BACKUP_DIR = existsSync('/backup') ? '/backup' : '/srv/incudal-backups'
const CONF = existsSync('/backup/incudal-backup.conf') ? '/backup/incudal-backup.conf' : '/srv/incudal-backup.conf'

/**
 * 配置文件是否可用于写入。
 * docker 把宿主机上不存在的文件 bind-mount 成目录时，写会失败（EISDIR），
 * 这种情况要给出人话提示，而不是抛 500。
 */
function confWriteError(): string | null {
  try {
    const st = statSync(CONF)
    if (st.isDirectory()) {
      return `备份配置文件路径是个目录（${CONF}）。宿主机上 /srv/incudal-backup.conf 不存在，请先 touch 一个空文件再重启面板`
    }
  } catch {
    // 文件不存在：只要父目录可写就能新建
    try {
      accessSync(dirname(CONF), constants.W_OK)
    } catch {
      return `备份配置目录不可写（${dirname(CONF)}），请检查容器挂载权限`
    }
  }
  return null
}

/** 备份文件名白名单：只允许 incudal-*.dump / incudal-db-*.sql.gz / pre-import-*.dump */
function safeBackupName(name: string): string | null {
  const b = basename(String(name || ''))
  if (!/^(incudal-[0-9-]+\.sql\.gz|incudal-[0-9-]+\.dump|incudal-db-[0-9-]+\.sql\.gz|pre-import-[0-9-]+\.(sql\.gz|dump))$/.test(b)) return null
  return b
}

/** 读 conf（shell 变量格式），只取我们认识的键 */
function readConf(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const txt = readFileSync(CONF, 'utf-8')
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*(#.*)?$/.exec(line)
      if (m) out[m[1]] = m[2].trim()
    }
  } catch { /* 文件不存在 → 返回空 */ }
  return out
}

/** 写 conf：保留注释，只替换已知键的值；缺键则追加 */
function writeConf(patch: Record<string, string>): void {
  let txt = ''
  try { txt = readFileSync(CONF, 'utf-8') } catch { txt = '# ===== Incudal 备份配置 =====\n' }
  const lines = txt.split('\n')
  const done = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([A-Z_]+)\s*=/.exec(lines[i])
    if (m && patch[m[2]] !== undefined) {
      lines[i] = `${m[1]}${m[2]}="${patch[m[2]]}"`
      done.add(m[2])
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!done.has(k)) lines.push(`${k}="${v}"`)
  }
  writeFileSync(CONF, lines.join('\n'), 'utf-8')
}

/**
 * 面板跑在容器里，没有 docker 权限也看不到宿主机 /root，所以备份/导入只能
 * 写一个请求文件，由宿主机 cron 每分钟跑的 incudal-backup-trigger.sh 真正执行。
 * 这里：写请求 → 轮询结果 → 返回。
 */
/** 只把请求写到宿主机，不等待结果（长任务用这个，避免 HTTP 长请求被网关掐断） */
function queueTrigger(action: string, name?: string, mode?: string): { ok: boolean; error?: string } {
  const reqFile = join(BACKUP_DIR, '.request')
  const resFile = join(BACKUP_DIR, '.result')
  try {
    try { unlinkSync(resFile) } catch { /* 无旧结果 */ }
    const payload = action === 'run' ? 'run\n'
      : action === 'set-schedule' ? `set-schedule\n${name}\n${mode}\n`
      : action === 'set-auto' ? `set-auto\n${name}\n`
      : action === 'git-get' ? `git-get\n${name}\n`
      : action === 'git-del' ? `git-del\n${name}\n`
      : action === 'import' ? `import\n${name}\n${mode}\n`
      : `${action}\n`
    writeFileSync(reqFile, payload, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: '无法写请求文件（备份目录不可写？）: ' + String((e as Error).message) }
  }
}

async function fireTrigger(action: 'run' | 'import' | 'install-rclone' | 'gen-ssh-key' | 'set-schedule' | 'verify-archive' | 'set-auto' | 'git-list' | 'clear-log' | 'git-get' | 'git-del', name?: string, mode?: string, maxWaitMs = 10 * 60 * 1000): Promise<{ ok: boolean; code: number; detail: string; error?: string }> {
  const reqFile = join(BACKUP_DIR, '.request')
  const resFile = join(BACKUP_DIR, '.result')
  // 触发器没在跑（.status 不新鲜）→ 直接返回，不写请求、不空等
  const host = hostReadiness()
  if (!host.trigger) {
    return { ok: false, code: 1, detail: '', error: host.reason || '宿主机触发器未运行' }
  }
  try {
    try { unlinkSync(resFile) } catch { /* 无旧结果 */ }
    const payload = action === 'run' ? 'run\n'
      : action === 'install-rclone' ? 'install-rclone\n'
      : action === 'gen-ssh-key' ? 'gen-ssh-key\n'
      : action === 'set-schedule' ? `set-schedule\n${name}\n${mode}\n`
      : action === 'verify-archive' ? 'verify-archive\n'
      : action === 'set-auto' ? `set-auto\n${name}\n`
      : action === 'git-list' ? 'git-list\n'
      : action === 'clear-log' ? 'clear-log\n'
      : action === 'git-get' ? `git-get\n${name}\n`
      : action === 'git-del' ? `git-del\n${name}\n`
      : `import\n${name}\n${mode}\n`
    writeFileSync(reqFile, payload, 'utf-8')
  } catch (e) {
    return { ok: false, code: 1, detail: '', error: '无法写请求文件（备份目录不可写？）: ' + String((e as Error).message) }
  }
  const maxTries = Math.max(1, Math.ceil(maxWaitMs / 3000))
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const line = readFileSync(resFile, 'utf-8').split('\n')[0]
      const parts = line.split('|')
      const code = Number(parts[1] ?? 1)
      try { unlinkSync(resFile) } catch { /* ignore */ }
      return { ok: code === 0, code, detail: parts.slice(2).join('|') }
    } catch { /* 还没结果，继续等 */ }
  }
  return { ok: false, code: 1, detail: '', error: '等待宿主机执行超时（检查 cron 是否在跑 incudal-backup-trigger.sh）' }
}

/** 读宿主机触发器写的状态文件（容器内看不到宿主机环境） */
function readHostStatus(): { rclone: boolean; scripts: boolean; sshkey: boolean; at: string } {
  try {
    const txt = readFileSync(join(BACKUP_DIR, '.status'), 'utf-8')
    const get = (k: string) => (new RegExp('^' + k + '=(.*)$', 'm').exec(txt)?.[1] || '').trim()
    return { rclone: get('rclone') === 'yes', scripts: get('scripts') === 'yes', sshkey: get('sshkey') === 'yes', at: get('at') }
  } catch { return { rclone: false, scripts: false, sshkey: false, at: '' } }
}

/**
 * 宿主机侧是否真的可用。
 * 面板在容器里看不到 /usr/local/bin/incudal-*.sh，唯一可信的判据是
 * 宿主机触发器每分钟写的 .status：文件存在且新鲜 = 触发器在跑；
 * 里面的 scripts=yes = 备份脚本已安装。
 */
function hostReadiness(): { scripts: boolean; trigger: boolean; ageSec: number | null; reason: string } {
  const st = readHostStatus()
  let ageSec: number | null = null
  try {
    ageSec = Math.round((Date.now() - statSync(join(BACKUP_DIR, '.status')).mtimeMs) / 1000)
  } catch { ageSec = null }

  // 触发器每 60 秒写一次，90 秒没更新就认为没在跑
  const trigger = ageSec !== null && ageSec <= 90
  const scripts = st.scripts

  let reason = ''
  if (!scripts && !trigger) reason = '宿主机没有安装备份脚本，触发器也没有在跑：请在宿主机执行 scripts/install-backup.sh'
  else if (!scripts) reason = '宿主机缺少 incudal-backup.sh / incudal-restore.sh：请重新执行 scripts/install-backup.sh'
  else if (!trigger) reason = `宿主机触发器未运行（.status ${ageSec === null ? '不存在' : `已 ${ageSec} 秒未更新`}）：请检查 crontab 里的 incudal-backup-trigger.sh`
  return { scripts, trigger, ageSec, reason }
}

// GitHub 备份列表缓存：/admin/backup/list 依赖宿主机触发器（每分钟一次），
// 同步等结果会让页面「刷新」卡几十秒，所以缓存 + 短超时。
let gitListCache: { at: number; detail: string } | null = null
const GIT_LIST_TTL_MS = 60_000

export default async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  // ---------------- 读配置 ----------------
  fastify.get('/admin/backup/config', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const c = readConf()
    const host = hostReadiness()
    return {
      // 没填仓库地址就不算启用（避免「没填地址却显示已启用」）
      githubEnabled: c.GITHUB_ENABLED === 'true' && !!(c.GITHUB_REPO || '').trim(),
      githubRepo: c.GITHUB_REPO || '',
      githubBranch: c.GITHUB_BRANCH || 'main',
      rcloneEnabled: c.RCLONE_ENABLED === 'true',
      rcloneRemote: c.RCLONE_REMOTE || '',
      rcloneKeep: Number(c.RCLONE_KEEP || 30),
      keepDays: Number(c.KEEP_DAYS || 14),
      // GitHub 私库保留天数：之前只写在宿主机 conf 里（默认 7），后台看不到也改不了
      githubKeepDays: Number(c.GITHUB_KEEP_DAYS || 7),
      backupTime: c.BACKUP_TIME || '03:10',
      backupTz: c.BACKUP_TZ || 'Asia/Shanghai',
      // 配置里写着 on，但宿主机没脚本/触发器没跑 → 实际不会备份，按关闭显示
      autoBackup: (c.AUTO_BACKUP || 'off') === 'on' && host.scripts && host.trigger,
      autoBackupConfigured: (c.AUTO_BACKUP || 'off') === 'on',
      hostTriggerAlive: host.trigger,
      hostStatusAgeSec: host.ageSec,
      hostReason: host.reason,
      // 面板在容器里，看不到宿主机的脚本文件；真正的可用性判据是
      // 备份目录可写（能写 .request 让宿主机触发器接手）。
      // 真判据：宿主机脚本装没装（目录可写只是容器自己的事，不能当「就绪」）
      scriptsReady: host.scripts && host.trigger,
      dirWritable: (() => { try { return existsSync(BACKUP_DIR) && accessSync(BACKUP_DIR, constants.W_OK) === undefined } catch { return false } })(),
      // rclone / 脚本都在宿主机上，容器里看不到 → 由宿主机触发器写 .status 上报
      rcloneInstalled: readHostStatus().rclone,
      hostScriptsReady: readHostStatus().scripts,
      sshKeyReady: readHostStatus().sshkey,
    }
  })

  // ---------------- 写配置 ----------------
  fastify.put<{ Body: Record<string, unknown> }>(
    '/admin/backup/config',
    { onRequest: [fastify.authenticate, fastify.requireAdmin] },
    async (request, reply) => {
      const b = request.body || {}
      const patch: Record<string, string> = {}
      const str = (v: unknown) => String(v ?? '').trim()

      if (b.githubEnabled !== undefined) {
        if (b.githubEnabled) {
          // 启用时必须同时提供仓库地址（或库里已有）
          const repo = (str(b.githubRepo) || readConf().GITHUB_REPO || '').trim()
          if (!repo) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '启用 GitHub 私库前请先填写仓库地址'))
        }
        patch.GITHUB_ENABLED = b.githubEnabled ? 'true' : 'false'
      }
      if (b.githubRepo !== undefined) {
        const r = str(b.githubRepo)
        // 只接受 git@github.com:owner/repo.git 或 https 形式，避免被塞任意 shell
        if (r && !/^(git@[\w.-]+:[\w.-]+\/[\w.-]+\.git|https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\.git)$/.test(r)) {
          return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, 'GitHub 仓库地址格式不对（应形如 git@github.com:用户名/仓库.git）'))
        }
        patch.GITHUB_REPO = r
      }
      if (b.githubBranch !== undefined) patch.GITHUB_BRANCH = str(b.githubBranch) || 'main'
      if (b.rcloneEnabled !== undefined) patch.RCLONE_ENABLED = b.rcloneEnabled ? 'true' : 'false'
      if (b.rcloneRemote !== undefined) {
        const r = str(b.rcloneRemote)
        if (r && !/^[\w.-]+:[\w./-]*$/.test(r)) {
          return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '网盘路径格式不对（应形如 gdrive:incudal-backups）'))
        }
        patch.RCLONE_REMOTE = r
      }
      if (b.rcloneKeep !== undefined) {
        const n = Number(b.rcloneKeep)
        if (!Number.isInteger(n) || n < 0 || n > 3650) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '远端保留天数需为 0-3650 的整数'))
        patch.RCLONE_KEEP = String(n)
      }
      if (b.backupTime !== undefined) {
        const t = String(b.backupTime).trim()
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
          return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '备份时间格式应为 HH:MM（24 小时制）'))
        }
        patch.BACKUP_TIME = t
      }
      if (b.backupTz !== undefined) {
        const z = String(b.backupTz).trim()
        if (z && !/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z][A-Za-z0-9_+-]*$/.test(z)) {
          return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '时区格式不对（应形如 Asia/Shanghai）'))
        }
        patch.BACKUP_TZ = z || 'Asia/Shanghai'
      }
      let autoChange: boolean | null = null
      if (b.autoBackup !== undefined) {
        // 想开自动备份，但宿主机没脚本 → 直接拒绝，避免「显示已启用但永远不跑」
        if (b.autoBackup) {
          const host = hostReadiness()
          if (!host.scripts || !host.trigger) {
            return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '无法开启自动备份：' + host.reason))
          }
        }
        patch.AUTO_BACKUP = b.autoBackup ? 'on' : 'off'
        autoChange = !!b.autoBackup
      }
      if (b.keepDays !== undefined) {
        const n = Number(b.keepDays)
        if (!Number.isInteger(n) || n < 1 || n > 3650) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '本地保留天数需为 1-3650 的整数'))
        patch.KEEP_DAYS = String(n)
      }
      if (b.githubKeepDays !== undefined) {
        const n = Number(b.githubKeepDays)
        if (!Number.isInteger(n) || n < 1 || n > 3650) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, 'GitHub 私库保留天数需为 1-3650 的整数'))
        patch.GITHUB_KEEP_DAYS = String(n)
      }
      if (!Object.keys(patch).length) return { ok: true, changed: 0, noChange: true }

      const werr = confWriteError()
      if (werr) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, werr))

      try {
        writeConf(patch)
      } catch (e) {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '写入备份配置失败: ' + String((e as Error).message)))
      }
      await logAdminAction(request.user.id, 'backup.config.update', { resourceType: 'backup_config', newValue: { keys: Object.keys(patch) } }).catch(() => {})

      // 时间/时区变了 → 立刻重写宿主机 crontab
      // 不再同步等宿主机执行（那是 60 秒级的 cron，等待会让页面卡住甚至被网关掐成 502）。
      // 只把请求写下去，立即返回；宿主机最多 1 分钟内应用。
      let pending = false
      if (patch.BACKUP_TIME !== undefined || patch.BACKUP_TZ !== undefined) {
        const c = readConf()
        pending = !queueTrigger('set-schedule', c.BACKUP_TIME || '03:10', c.BACKUP_TZ || 'Asia/Shanghai').ok || pending
      }
      if (autoChange !== null) {
        pending = !queueTrigger('set-auto', autoChange ? 'on' : 'off').ok || pending
      }
      return { ok: true, changed: Object.keys(patch).length, pending }
    }
  )

  // ---------------- GitHub 部署密钥 ----------------
  fastify.get('/admin/backup/github-key', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    let pub = ''
    try { pub = readFileSync(join(BACKUP_DIR, '.github_key_pub'), 'utf-8').trim() } catch { /* 还没生成 */ }
    return { exists: readHostStatus().sshkey, publicKey: pub }
  })

  fastify.post('/admin/backup/gen-ssh-key', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    if (readHostStatus().sshkey) {
      let pub = ''
      try { pub = readFileSync(join(BACKUP_DIR, '.github_key_pub'), 'utf-8').trim() } catch { /* ignore */ }
      if (pub) return { ok: true, alreadyExists: true, publicKey: pub }
    }
    const out = await fireTrigger('gen-ssh-key')
    await logAdminAction(request.user.id, 'backup.genSshKey', { resourceType: 'backup' }).catch(() => {})
    if (!out.ok) return reply.code(500).send({ ok: false, error: out.error || '密钥生成失败', output: out.detail })
    let pub = ''
    try { pub = readFileSync(join(BACKUP_DIR, '.github_key_pub'), 'utf-8').trim() } catch { /* ignore */ }
    return { ok: true, publicKey: pub }
  })

  // ---------------- 列出备份 ----------------
  fastify.get('/admin/backup/list', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const items: Array<{ name: string; size: number; mtime: string; kind: string }> = []
    try {
      for (const f of readdirSync(BACKUP_DIR)) {
        if (!/\.(dump|sql\.gz)$/.test(f)) continue
        const st = statSync(join(BACKUP_DIR, f))
        items.push({
          name: f,
          size: st.size,
          mtime: st.mtime.toISOString(),
          kind: f.startsWith('pre-import-') ? 'pre-import' : 'backup'
        })
      }
    } catch { /* 目录不存在 */ }
    const c = readConf()
    const ghOn = c.GITHUB_ENABLED === 'true' && !!(c.GITHUB_REPO || '').trim()

    // 启用 GitHub 时本地不留副本 → 列表与统计都以 GitHub 仓库为准
    if (ghOn) {
      let detail = ''
      // 1) 优先读宿主机触发器每分钟写的 .gitlist —— 无需等待，秒开
      try {
        const st = statSync(join(BACKUP_DIR, '.gitlist'))
        if (Date.now() - st.mtimeMs < 5 * 60 * 1000) {
          detail = readFileSync(join(BACKUP_DIR, '.gitlist'), 'utf-8').trim()
          if (detail) gitListCache = { at: Date.now(), detail }
        }
      } catch { /* 没有 .gitlist，走下面的兜底 */ }

      const fresh = gitListCache && Date.now() - gitListCache.at < GIT_LIST_TTL_MS
      if (detail) {
        // 已有可用数据，直接用
      } else if (fresh) {
        detail = gitListCache!.detail
      } else {
        // 最多等 12 秒；宿主机触发器没赶上就用上一次的缓存，避免整页卡住
        const out = await fireTrigger('git-list', undefined, undefined, 12_000)
        if (out.ok) {
          detail = out.detail || ''
          gitListCache = { at: Date.now(), detail }
        } else if (gitListCache) {
          detail = gitListCache.detail
        }
      }
      const remote: Array<{ name: string; size: number; mtime: string; kind: string }> = []
      if (detail) {
        for (const seg of detail.split(';')) {
          const p = seg.trim().split('|')
          if (p.length < 3) continue
          const nm = basename(p[0])
          if (!nm.startsWith('incudal-')) continue
          const ts = Number(p[2]) || 0
          remote.push({
            name: nm,
            size: Number(p[1]) || 0,
            mtime: new Date(ts * 1000).toISOString(),
            kind: 'backup'
          })
        }
      }
      remote.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      return {
        items: remote,
        totalSize: remote.reduce((s, i) => s + i.size, 0),
        keepDays: Number(c.GITHUB_KEEP_DAYS || 7),
        source: 'github',
        localItems: items.length
      }
    }

    items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    return {
      items,
      totalSize: items.reduce((s, i) => s + i.size, 0),
      keepDays: Number(c.KEEP_DAYS || 14),
      source: 'local',
      localItems: items.length
    }
  })

  // ---------------- 日志 ----------------
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/admin/backup/log',
    { onRequest: [fastify.authenticate, fastify.requireAdmin] },
    async (request) => {
      let text = ''
      try { text = readFileSync(join(BACKUP_DIR, 'backup.log'), 'utf-8') } catch { text = '' }
      let all = text.trim() ? text.trim().split('\n') : []
      const from = (request.query?.from || '').trim()
      const to = (request.query?.to || '').trim()
      const okDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)
      if (okDate(from) || okDate(to)) {
        all = all.filter((l) => {
          // 日志形如 [2026-10-15 13:41:52] ...
          const m = /^\[(\d{4}-\d{2}-\d{2})/.exec(l)
          if (!m) return false
          const d = m[1]
          if (okDate(from) && d < from) return false
          if (okDate(to) && d > to) return false
          return true
        })
      }
      const lines = all.slice(-500).reverse()
      return { lines, total: all.length }
    }
  )

  // 清空日志
  fastify.delete('/admin/backup/log', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    const out = await fireTrigger('clear-log')
    await logAdminAction(request.user.id, 'backup.clearLog', { resourceType: 'backup' }).catch(() => {})
    if (!out.ok) return reply.code(500).send({ ok: false, error: out.error || '清空失败' })
    return { ok: true }
  })

  // ---------------- 立即备份（走宿主机触发器）----------------
  // 立即备份：只下发请求，立即返回；前端轮询 /admin/backup/run/status 拿结果。
  // 之前是同步等宿主机执行完（最长 10 分钟），网关一超时就变成「一直显示备份中」。
  fastify.post('/admin/backup/run', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    const host = hostReadiness()
    if (!host.scripts || !host.trigger) {
      return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '宿主机备份环境未就绪：' + host.reason))
    }
    const queued = queueTrigger('run')
    if (!queued.ok) return reply.code(500).send({ ok: false, error: queued.error })
    await logAdminAction(request.user.id, 'backup.run', { resourceType: 'backup' }).catch(() => {})
    return { ok: true, started: true, message: '已提交，宿主机正在执行（最多约 1 分钟）' }
  })

  // 备份执行状态（轮询用；读到结果后清掉 .result）
  fastify.get('/admin/backup/run/status', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const resFile = join(BACKUP_DIR, '.result')
    try {
      const line = readFileSync(resFile, 'utf-8').split('\n')[0]
      const parts = line.split('|')
      const code = Number(parts[1] ?? 1)
      try { unlinkSync(resFile) } catch { /* ignore */ }
      return { done: true, ok: code === 0, detail: parts.slice(2).join('|') }
    } catch {
      return { done: false }
    }
  })

  // ---------------- 下载 ----------------
  fastify.get<{ Params: { name: string } }>(
    '/admin/backup/download/:name',
    { onRequest: [fastify.authenticate, fastify.requireAdmin] },
    async (request, reply) => {
      const name = safeBackupName(request.params.name)
      if (!name) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '文件名不合法'))
      const p = join(BACKUP_DIR, name)
      let tempCopy = false
      if (!existsSync(p)) {
        // GitHub 模式下本地不留副本 → 先从仓库取出来（用完再删）
        const out = await fireTrigger('git-get', name)
        if (!out.ok) return reply.code(404).send(apiError(ErrorCode.NOT_FOUND, '备份文件不存在（仓库里也没有）'))
        tempCopy = true
      }
      if (!existsSync(p)) return reply.code(404).send(apiError(ErrorCode.NOT_FOUND, '备份文件不存在'))
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="${name}"`)
      const stream = createReadStream(p)
      if (tempCopy) {
        // 传完就删掉这份临时副本，保持「本地不留备份」
        stream.on('close', () => { try { unlinkSync(p) } catch { /* ignore */ } })
      }
      return reply.send(stream)
    }
  )

  // ---------------- 删除 ----------------
  fastify.delete<{ Params: { name: string } }>(
    '/admin/backup/:name',
    { onRequest: [fastify.authenticate, fastify.requireAdmin] },
    async (request, reply) => {
      const name = safeBackupName(request.params.name)
      if (!name) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '文件名不合法'))
      const c = readConf()
      const ghOn = c.GITHUB_ENABLED === 'true' && !!(c.GITHUB_REPO || '').trim()
      if (ghOn) {
        // GitHub 模式：从仓库删除并推送，才算真的删掉
        const out = await fireTrigger('git-del', name)
        await logAdminAction(request.user.id, 'backup.delete', { resourceType: 'backup', resourceName: name }).catch(() => {})
        if (!out.ok) return reply.code(500).send(apiError(ErrorCode.INTERNAL_ERROR, out.error || out.detail || '删除失败'))
        return { ok: true, synced: true }
      }
      const p = join(BACKUP_DIR, name)
      if (!existsSync(p)) return reply.code(404).send(apiError(ErrorCode.NOT_FOUND, '备份文件不存在'))
      try { unlinkSync(p) } catch { return reply.code(500).send(apiError(ErrorCode.INTERNAL_ERROR, '删除失败')) }
      await logAdminAction(request.user.id, 'backup.delete', { resourceType: 'backup', resourceName: name }).catch(() => {})
      return { ok: true }
    }
  )

  // ---------------- 上传备份文件（没有历史备份也能导入）----------------
  fastify.post<{ Body: { filename?: string; dataBase64?: string } }>(
    '/admin/backup/upload',
    { onRequest: [fastify.authenticate, fastify.requireAdmin], bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      const b = request.body || {}
      const raw = String(b.filename || '').trim()
      const name = safeBackupName(raw)
      if (!name) {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '文件名不合法（需为 incudal-*.dump / incudal-db-*.sql.gz）'))
      }
      const b64 = String(b.dataBase64 || '')
      if (!b64) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '没有收到文件内容'))
      let buf: Buffer
      try { buf = Buffer.from(b64, 'base64') } catch {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '文件内容不是合法 base64'))
      }
      if (!buf.length || buf.length > 512 * 1024 * 1024) {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '文件大小异常'))
      }
      // 落盘前先验证是不是真的 pg_dump 归档
      const tmp = join(BACKUP_DIR, '.upload_tmp')
      try { writeFileSync(tmp, buf) } catch {
        return reply.code(500).send(apiError(ErrorCode.INTERNAL_ERROR, '写入失败（备份目录不可写？）'))
      }
      const target = join(BACKUP_DIR, name)
      try {
        if (name.endsWith('.dump') || name.endsWith('.sql.gz')) {
          const out = await fireTrigger('verify-archive', name)
          if (!out.ok) {
            try { unlinkSync(tmp) } catch { /* ignore */ }
            return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '这不是有效的 pg_dump 归档：' + (out.detail || '').slice(0, 200)))
          }
        }
        const { renameSync } = await import('fs')
        renameSync(tmp, target)
        try { const { chmodSync } = await import('fs'); chmodSync(target, 0o644) } catch { /* ignore */ }
      } catch (e) {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        return reply.code(500).send(apiError(ErrorCode.INTERNAL_ERROR, '保存失败: ' + String((e as Error).message)))
      }
      await logAdminAction(request.user.id, 'backup.upload', { resourceType: 'backup', resourceName: name }).catch(() => {})
      return { ok: true, name, size: buf.length }
    }
  )

  // ---------------- 导入（异步：立刻返回，前端轮询状态）----------------
  // 导入要跑很久（几十秒到几分钟），走 nginx/Cloudflare 会被掐断成 502，
  // 所以这里只负责下发请求，不等结果。
  fastify.post<{ Body: { name?: string; mode?: string; confirm?: string } }>(
    '/admin/backup/import',
    { onRequest: [fastify.authenticate, fastify.requireAdmin] },
    async (request, reply) => {
      const b = request.body || {}
      const name = safeBackupName(String(b.name || ''))
      if (!name) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '文件名不合法'))
      const mode = b.mode === 'merge' ? 'merge' : 'overwrite'
      if (String(b.confirm || '') !== 'RESTORE') {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '导入需确认：请在请求里带 confirm="RESTORE"'))
      }
      if (!existsSync(join(BACKUP_DIR, name))) {
        const g = await fireTrigger('git-get', name)
        if (!g.ok) return reply.code(404).send(apiError(ErrorCode.NOT_FOUND, '备份文件不存在（仓库里也没有）'))
      }
      const reqFile = join(BACKUP_DIR, '.request')
      const resFile = join(BACKUP_DIR, '.result')
      try {
        try { unlinkSync(resFile) } catch { /* ignore */ }
        writeFileSync(reqFile, `import\n${name}\n${mode}\n`, 'utf-8')
      } catch (e) {
        return reply.code(500).send(apiError(ErrorCode.INTERNAL_ERROR, '无法下发导入请求: ' + String((e as Error).message)))
      }
      await logAdminAction(request.user.id, 'backup.import.start', { resourceType: 'backup', resourceName: name, newValue: { mode } }).catch(() => {})
      return { ok: true, started: true, mode }
    }
  )

  // 查询导入进度（前端每 3 秒轮询一次）
  fastify.get('/admin/backup/import/status', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const resFile = join(BACKUP_DIR, '.result')
    try {
      const line = readFileSync(resFile, 'utf-8').split('\n')[0]
      const parts = line.split('|')
      const code = Number(parts[1] ?? 1)
      try { unlinkSync(resFile) } catch { /* ignore */ }
      return { done: true, ok: code === 0, detail: parts.slice(2).join('|') }
    } catch {
      return { done: false }
    }
  })
}
