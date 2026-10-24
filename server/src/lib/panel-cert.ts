/**
 * 面板 mTLS 客户端证书（节点安装时通过 /api/hosts/cert/<token> 下发）。
 *
 * 问题背景：仓库里的 server/certs 只有 .gitkeep，证书从来没被自动生成过，
 * 新装的机器上 /api/hosts/cert/<token> 直接 500 "Certificate file not found"，
 * 节点安装脚本第 5 步必然失败。
 *
 * 这里做两件事：
 *  1) 启动时确保证书存在（缺失则用 openssl 生成，RSA 2048 / 10 年 / CN=incudal-panel）
 *  2) 生成失败时给出可执行的修复提示，而不是一句 500
 *
 * 证书必须**持久化**：换一张证书，已安装的节点会因为指纹不匹配而全部失联。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, chmodSync, statSync, accessSync, constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 项目是 ESM（package.json type=module），没有全局 __dirname
const HERE = dirname(fileURLToPath(import.meta.url))

export interface PanelCertPaths {
  crt: string
  key: string
}

/** 证书路径：环境变量优先，否则 server/certs（容器里 /app/server/certs）。 */
export function panelCertPaths(): PanelCertPaths {
  const crt = process.env.PANEL_CRT_PATH || join(HERE, '../../certs/client.crt')
  const key = process.env.PANEL_KEY_PATH || join(HERE, '../../certs/client.key')
  return { crt, key }
}

export interface EnsureCertResult {
  ok: boolean
  generated: boolean
  paths: PanelCertPaths
  error?: string
}

/** 把 EACCES/ENOENT 之类翻译成人能看懂、能直接执行的提示。 */
export function describeCertError(paths: PanelCertPaths, err: unknown): string {
  const e = err as NodeJS.ErrnoException
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const target = e?.path || paths.key

  if (e?.code === 'EACCES' || e?.code === 'EPERM') {
    let owner = ''
    try {
      const st = statSync(target)
      owner = `当前 ${st.uid}:${st.gid} ${(st.mode & 0o777).toString(8)}`
    } catch { /* 忽略 */ }
    return `证书文件权限不足（${target}，${owner || '无法读取属主'}，面板进程 uid=${uid}）。` +
      `修复：sudo chown 1001:65533 ${paths.crt} ${paths.key} && sudo chmod 600 ${paths.key} && sudo chmod 644 ${paths.crt}`
  }
  if (e?.code === 'ENOENT') {
    return `证书文件不存在（${target}）。修复：重启面板会自动生成，或执行 sudo bash scripts/install-docker.sh`
  }
  return `证书读取失败（${target}）：${e?.message || String(err)}`
}

/** 证书是否真的可读（root 生成的 600 文件，容器内 uid 1001 会 EACCES）。 */
function certReadable(paths: PanelCertPaths): string | null {
  for (const p of [paths.crt, paths.key]) {
    try {
      accessSync(p, constants.R_OK)
    } catch (e) {
      return describeCertError(paths, e)
    }
  }
  return null
}

/** 生成自签名客户端证书（幂等：已存在就直接返回）。 */
export function ensurePanelCert(): EnsureCertResult {
  const paths = panelCertPaths()
  if (existsSync(paths.crt) && existsSync(paths.key)) {
    const unreadable = certReadable(paths)
    if (unreadable) return { ok: false, generated: false, paths, error: unreadable }
    return { ok: true, generated: false, paths }
  }

  const dir = dirname(paths.crt)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return {
      ok: false,
      generated: false,
      paths,
      error: `无法创建证书目录 ${dir}: ${(e as Error).message}`
    }
  }

  try {
    // alpine 基础镜像默认不带 openssl CLI，Dockerfile 里已 apk add openssl
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', paths.key,
      '-out', paths.crt,
      '-days', '3650',
      '-subj', '/CN=incudal-panel/O=Incudal'
    ], { stdio: 'pipe', timeout: 30_000 })
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return {
      ok: false,
      generated: false,
      paths,
      error:
        'openssl 生成证书失败：' + msg +
        `（目标目录 ${dir} 是否可写？容器内该目录是 bind mount 时需要 chown 1001:65533）`
    }
  }

  try {
    chmodSync(paths.key, 0o600)
    chmodSync(paths.crt, 0o644)
  } catch { /* 权限失败不致命 */ }

  return { ok: true, generated: true, paths }
}

/** 证书指纹（SHA-256），用于后台展示/排查节点是否用了同一张证书。 */
export function panelCertFingerprint(): string | null {
  const { crt } = panelCertPaths()
  try {
    if (!statSync(crt).isFile()) return null
    const out = execFileSync('openssl', ['x509', '-in', crt, '-noout', '-fingerprint', '-sha256'], {
      encoding: 'utf-8',
      timeout: 10_000
    })
    return out.trim().replace(/^.*=/, '').trim()
  } catch {
    return null
  }
}
