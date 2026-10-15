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
import { join, basename } from 'path'
import { apiError, ErrorCode } from '../lib/errors.js'
import { logAdminAction } from '../lib/security.js'

const BACKUP_DIR = existsSync('/backup') ? '/backup' : '/srv/incudal-backups'
const CONF = existsSync('/backup/incudal-backup.conf') ? '/backup/incudal-backup.conf' : '/srv/incudal-backup.conf'

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
async function fireTrigger(action: 'run' | 'import' | 'install-rclone' | 'gen-ssh-key' | 'set-schedule' | 'verify-archive' | 'set-auto' | 'git-list' | 'clear-log' | 'git-get' | 'git-del', name?: string, mode?: string): Promise<{ ok: boolean; code: number; detail: string; error?: string }> {
  const reqFile = join(BACKUP_DIR, '.request')
  const resFile = join(BACKUP_DIR, '.result')
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
  for (let i = 0; i < 200; i++) {          // 最多等 10 分钟
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

export default async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  // ---------------- 读配置 ----------------
  fastify.get('/admin/backup/config', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async () => {
    const c = readConf()
    return {
      // 没填仓库地址就不算启用（避免「没填地址却显示已启用」）
      githubEnabled: c.GITHUB_ENABLED === 'true' && !!(c.GITHUB_REPO || '').trim(),
      githubRepo: c.GITHUB_REPO || '',
      githubBranch: c.GITHUB_BRANCH || 'main',
      rcloneEnabled: c.RCLONE_ENABLED === 'true',
      rcloneRemote: c.RCLONE_REMOTE || '',
      rcloneKeep: Number(c.RCLONE_KEEP || 30),
      keepDays: Number(c.KEEP_DAYS || 14),
      backupTime: c.BACKUP_TIME || '03:10',
      backupTz: c.BACKUP_TZ || 'Asia/Shanghai',
      autoBackup: (c.AUTO_BACKUP || 'on') !== 'off',
      // 面板在容器里，看不到宿主机的脚本文件；真正的可用性判据是
      // 备份目录可写（能写 .request 让宿主机触发器接手）。
      scriptsReady: (() => { try { return existsSync(BACKUP_DIR) && accessSync(BACKUP_DIR, constants.W_OK) === undefined } catch { return false } })(),
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
        patch.AUTO_BACKUP = b.autoBackup ? 'on' : 'off'
        autoChange = !!b.autoBackup
      }
      if (b.keepDays !== undefined) {
        const n = Number(b.keepDays)
        if (!Number.isInteger(n) || n < 1 || n > 3650) return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '本地保留天数需为 1-3650 的整数'))
        patch.KEEP_DAYS = String(n)
      }
      if (!Object.keys(patch).length) return { ok: true, changed: 0, noChange: true }

      writeConf(patch)
      await logAdminAction(request.user.id, 'backup.config.update', { resourceType: 'backup_config', newValue: { keys: Object.keys(patch) } }).catch(() => {})

      // 时间/时区变了 → 立刻重写宿主机 crontab
      let scheduleApplied: string | null = null
      if (patch.BACKUP_TIME !== undefined || patch.BACKUP_TZ !== undefined) {
        const c = readConf()
        const out = await fireTrigger('set-schedule', c.BACKUP_TIME || '03:10', c.BACKUP_TZ || 'Asia/Shanghai')
        if (out.ok) scheduleApplied = (c.BACKUP_TIME || '03:10') + ' (' + (c.BACKUP_TZ || 'Asia/Shanghai') + ')'
        else return reply.code(500).send({ ok: false, error: '配置已保存，但 crontab 更新失败: ' + (out.error || out.detail) })
      }
      let autoApplied: string | null = null
      if (autoChange !== null) {
        const out = await fireTrigger('set-auto', autoChange ? 'on' : 'off')
        if (out.ok) autoApplied = autoChange ? 'on' : 'off'
        else return reply.code(500).send({ ok: false, error: '配置已保存，但 crontab 更新失败: ' + (out.error || out.detail) })
      }
      return { ok: true, changed: Object.keys(patch).length, scheduleApplied, autoApplied }
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
      const out = await fireTrigger('git-list')
      const remote: Array<{ name: string; size: number; mtime: string; kind: string }> = []
      if (out.ok && out.detail) {
        for (const seg of out.detail.split(';')) {
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
  fastify.post('/admin/backup/run', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    const out = await fireTrigger('run')
    if (!out.ok) return reply.code(500).send({ ok: false, error: out.error, log: out.detail })
    await logAdminAction(request.user.id, 'backup.run', { resourceType: 'backup' }).catch(() => {})
    return { ok: true, exitCode: out.code, log: out.detail }
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
