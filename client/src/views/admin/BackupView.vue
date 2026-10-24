<template>
  <div class="space-y-6 animate-fade-in">
    <div class="page-header flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="page-title">数据备份</h1>
        <p class="page-description">自动备份面板数据库到本地 / GitHub 私库 / 网盘，支持一键导入恢复</p>
      </div>
      <div class="bk-head-actions">
        <button class="bk-btn bk-btn-ghost" :disabled="loading" @click="loadAll">刷新</button>
        <button class="bk-btn bk-btn-primary" :disabled="running" @click="runBackup">
          {{ running ? '备份中…' : '立即备份' }}
        </button>
      </div>
    </div>

    <div v-if="msg.text" class="bk-alert" :class="msg.type === 'error' ? 'is-error' : 'is-ok'">
      {{ msg.text }}
      <span class="bk-x" @click="msg.text = ''">×</span>
    </div>

    <!-- 状态概览 -->
    <div class="card p-6">
      <h3>状态</h3>
      <div class="bk-grid">
        <div class="bk-stat"><span class="bk-k">上次备份</span><span class="bk-v">{{ lastBackupText }}</span></div>
        <div class="bk-stat"><span class="bk-k">备份数量</span><span class="bk-v">{{ items.length }} 份</span></div>
        <div class="bk-stat"><span class="bk-k">占用空间</span><span class="bk-v">{{ fmtSize(totalSize) }}</span></div>
        <div class="bk-stat"><span class="bk-k">本地保留</span><span class="bk-v">{{ cfg.keepDays }} 天</span></div>
        <div class="bk-stat">
          <span class="bk-k">备份脚本</span>
          <span class="bk-v" :class="cfg.scriptsReady ? 'ok' : 'bad'">{{ cfg.scriptsReady ? '就绪' : '缺失' }}</span>
        </div>
        <div class="bk-stat">
          <span class="bk-k">GitHub 私库</span>
          <span class="bk-v" :class="cfg.githubEnabled ? 'ok' : 'off'">
            {{ cfg.githubEnabled ? '已启用' : '未启用' }}
          </span>
        </div>
        <div class="bk-stat">
          <span class="bk-k">部署密钥</span>
          <span class="bk-v" :class="cfg.sshKeyReady ? 'ok' : 'off'">
            {{ cfg.sshKeyReady ? '已生成' : '未生成' }}
          </span>
        </div>
        <div class="bk-stat">
          <span class="bk-k">自动备份</span>
          <span class="bk-v" :class="cfg.autoBackup ? 'ok' : 'off'">
            {{ cfg.autoBackup ? '已启用' : '已关闭' }}
          </span>
        </div>
      </div>
      <p class="bk-hint">自动备份：每天 {{ form.backupTime }}（{{ form.backupTz }}）</p>
    </div>

    <!-- 配置 -->
    <div class="card p-6">
      <h3 class="text-base font-semibold mb-4">备份目标配置</h3>

      <!-- GitHub -->
      <label class="flex items-center gap-2 cursor-pointer mb-4">
        <input type="checkbox" v-model="form.githubEnabled" class="w-4 h-4 cursor-pointer" />
        <span class="text-sm">启用 GitHub 私库</span>
      </label>

      <div v-if="form.githubEnabled" class="space-y-4">
        <div class="flex flex-wrap gap-3 items-end">
          <div class="flex-1 min-w-[260px]">
            <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">仓库地址</label>
            <input class="input w-full" v-model.trim="form.githubRepo" placeholder="git@github.com:用户名/incudal-backups.git" />
          </div>
          <div class="w-[120px]">
            <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">分支</label>
            <input class="input w-full" v-model.trim="form.githubBranch" placeholder="main" />
          </div>
        </div>

        <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-xs px-2 py-0.5 rounded-full" :class="cfg.sshKeyReady ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'">
              {{ cfg.sshKeyReady ? '部署密钥已生成' : '还没有部署密钥' }}
            </span>
            <button v-if="!cfg.sshKeyReady" class="btn btn-primary text-sm" :disabled="genKeyBusy" @click="genSshKey">
              {{ genKeyBusy ? '安装中…' : '点击安装' }}
            </button>
          </div>

          <p class="text-xs text-gray-500 dark:text-gray-400 mt-3 leading-relaxed">
            <template v-if="!cfg.sshKeyReady">点「点击安装」自动生成部署密钥。</template>
            <template v-else>把下面的公钥加到 GitHub 仓库 → Settings → Deploy keys → Add deploy key（勾选 Allow write access）。</template>
          </p>

          <div v-if="publicKey" class="bk-key" :class="{ 'is-copied': copied }" @click="copyKey">
            <code class="bk-key-text">{{ publicKey }}</code>
            <span class="bk-key-tip">{{ copied ? '已复制 ✓' : '点击复制' }}</span>
          </div>
        </div>
      </div>

      <div class="border-t border-gray-200 dark:border-gray-700 my-5"></div>

      <!-- 定时与保留 -->
      <div class="flex flex-wrap gap-4 items-end">
        <div class="flex items-center gap-2 pb-2.5">
          <input id="bk-auto" type="checkbox" v-model="form.autoBackup" class="w-4 h-4 cursor-pointer" />
          <label for="bk-auto" class="text-sm cursor-pointer whitespace-nowrap">启用自动备份</label>
        </div>
        <div class="w-[150px]">
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">备份时间</label>
          <input class="input w-full" type="time" v-model.trim="form.backupTime" :disabled="!form.autoBackup" />
        </div>
        <div class="w-[240px]">
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">时区</label>
          <select class="input w-full" v-model="form.backupTz" :disabled="!form.autoBackup">
            <option value="Asia/Shanghai">中国标准时间 (Asia/Shanghai)</option>
            <option value="Asia/Taipei">台北 (Asia/Taipei)</option>
            <option value="Asia/Hong_Kong">香港 (Asia/Hong_Kong)</option>
            <option value="Asia/Tokyo">东京 (Asia/Tokyo)</option>
            <option value="Asia/Singapore">新加坡 (Asia/Singapore)</option>
            <option value="UTC">UTC</option>
            <option value="America/Los_Angeles">洛杉矶 (America/Los_Angeles)</option>
            <option value="America/New_York">纽约 (America/New_York)</option>
            <option value="Europe/London">伦敦 (Europe/London)</option>
          </select>
        </div>
        <div class="w-[130px]">
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">本地保留（天）</label>
          <input class="input w-full" type="number" min="1" max="3650" v-model.number="form.keepDays" />
        </div>

        <div class="ml-auto">
          <button class="btn btn-primary" :disabled="saving" @click="saveConfig">
            {{ saving ? '保存中…' : '保存配置' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 备份列表 -->
    <div class="card p-6">
      <div class="flex items-center gap-3 flex-wrap mb-3">
        <h3 class="text-base font-semibold">备份文件</h3>
        <span class="text-xs px-2 py-0.5 rounded-full" :class="listSource === 'github' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">
          {{ listSource === 'github' ? '来源：GitHub 私库（远程）' : '来源：本地服务器' }}
        </span>
        <span v-if="listSource === 'github'" class="text-xs text-gray-500 dark:text-gray-400">
          启用 GitHub 后本地不留副本，所以这里显示的是远端仓库里的备份
        </span>
      </div>

      <div class="bk-upload">
        <label class="bk-btn bk-btn-ghost">
          {{ uploading ? '上传中…' : '上传备份文件' }}
          <input type="file" accept=".dump,.gz,.sql.gz" style="display:none" :disabled="uploading" @change="onUpload" />
        </label>
        <span class="bk-hint" style="margin:0">
          从本机选一份 .dump / .sql.gz 上传到服务器，上传完就能在下面点「导入」
        </span>
      </div>

      <div v-if="!items.length" class="bk-empty">暂无备份</div>
      <table v-else class="bk-table">
        <thead>
          <tr><th>文件名</th><th>类型</th><th>大小</th><th>时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.name">
            <td class="bk-mono">{{ it.name }}</td>
            <td>
              <span class="bk-tag" :class="it.kind === 'pre-import' ? 'bk-tag-warn' : 'bk-tag-ok'">
                {{ it.kind === 'pre-import' ? '导入前快照' : '备份' }}
              </span>
            </td>
            <td>{{ fmtSize(it.size) }}</td>
            <td>{{ fmtTime(it.mtime) }}</td>
            <td class="bk-td-actions">
              <button class="bk-link" @click="download(it)">下载</button>
              <button class="bk-link bk-link-primary" @click="openImport(it)">导入</button>
              <button class="bk-link bk-link-danger" @click="removeBackup(it)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 日志 -->
    <div class="card p-6">
      <h3 class="text-base font-semibold mb-4">备份日志</h3>

      <div class="flex flex-wrap gap-3 items-end mb-4">
        <div class="w-[150px]">
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">起始日期</label>
          <input class="input w-full" type="date" v-model="logFrom" />
        </div>
        <div class="w-[150px]">
          <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1.5">结束日期</label>
          <input class="input w-full" type="date" v-model="logTo" />
        </div>
        <button class="btn btn-primary" :disabled="logLoading" @click="loadLog">
          {{ logLoading ? '查询中…' : '查询' }}
        </button>
        <button class="btn" :disabled="logLoading" @click="logReset">全部</button>
        <button class="btn ml-auto" style="color:#f87171" @click="clearLog">清除日志</button>
      </div>

      <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">
        当前显示 {{ logLines.length }} 条{{ logFrom || logTo ? '（已按日期筛选）' : '（全部，最新的在最上面）' }}
      </p>

      <pre class="bk-log">{{ logText }}</pre>
    </div>

    <!-- 导入确认弹窗 -->
    <div
      v-if="importTarget"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background: rgba(0,0,0,.55)"
      @click.self="importTarget = null"
    >
      <div class="card p-6 w-full max-w-lg max-h-[85vh] overflow-auto">
        <h3 class="text-base font-semibold mb-1">导入备份</h3>
        <p class="text-xs text-gray-500 dark:text-gray-400 mb-4" style="word-break:break-all">{{ importTarget.name }}</p>

        <p class="text-sm mb-3">选择导入方式：</p>

        <div class="space-y-3 mb-4">
          <button
            class="w-full text-left px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 hover:border-blue-500 dark:hover:border-blue-400 transition-colors disabled:opacity-50"
            :disabled="importing"
            @click="doImport('merge')"
          >
            <span class="block text-sm font-medium mb-0.5">新增导入（只补缺失）</span>
            <span class="block text-xs text-gray-500 dark:text-gray-400">只补充备份里缺失的记录，不动现有数据</span>
          </button>

          <button
            class="w-full text-left px-4 py-3 rounded-lg border border-red-300 dark:border-red-800 hover:border-red-500 dark:hover:border-red-500 transition-colors disabled:opacity-50"
            :disabled="importing"
            @click="doImport('overwrite')"
          >
            <span class="block text-sm font-medium mb-0.5" style="color:#dc2626">覆盖导入（清空还原）</span>
            <span class="block text-xs text-gray-500 dark:text-gray-400">清空现有数据，完整还原成备份时的状态</span>
          </button>
        </div>

        <div class="text-xs px-3 py-2 rounded-lg mb-4" style="background: rgba(245,158,11,.12); color: #b45309">
          ⚠️ 导入会修改数据库。系统会在导入前自动存一份 pre-import 快照，可随时回退。
        </div>

        <div class="flex justify-end">
          <button class="btn" :disabled="importing" @click="importTarget = null">取消</button>
        </div>

        <pre v-if="importOutput" class="bk-log bk-log-sm">{{ importOutput }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 数据备份设置卡 —— 零依赖实现
 * 不引 @/api、vue-i18n、toast store：那些依赖在本项目的打包配置下会让组件
 * 静默渲染成注释节点（Vue 对 undefined vnode 的行为）。所以这里用裸 fetch。
 */
import { computed, onMounted, reactive, ref } from 'vue'

interface BackupItem { name: string; size: number; mtime: string; kind: string }

const loading = ref(false)
const saving = ref(false)
const running = ref(false)
const importing = ref(false)
const genKeyBusy = ref(false)
const uploading = ref(false)
const publicKey = ref('')
const copied = ref(false)
const items = ref<BackupItem[]>([])
const totalSize = ref(0)
const logLines = ref<string[]>([])
const logFrom = ref('')
const logTo = ref('')
const logLoading = ref(false)
const listSource = ref<'local' | 'github'>('local')
const msg = reactive<{ text: string; type: 'ok' | 'error' }>({ text: '', type: 'ok' })

const cfg = reactive({
  keepDays: 14,
  scriptsReady: false,
  sshKeyReady: false,
  githubEnabled: false,
  autoBackup: true
})

const form = reactive({
  autoBackup: true,
  backupTime: '03:10',
  backupTz: 'Asia/Shanghai',
  githubEnabled: false,
  githubRepo: '',
  githubBranch: 'main',
  keepDays: 14
})

const importTarget = ref<BackupItem | null>(null)
const importMode = ref<'overwrite' | 'merge'>('merge')
const importOutput = ref('')

function token(): string {
  return localStorage.getItem('token') || ''
}

async function req(path: string, init?: RequestInit): Promise<any> {
  // 只有带 body 时才设 Content-Type —— DELETE 等无 body 请求若声明
  // application/json，Fastify 会报 "Body cannot be empty when content-type is set to 'application/json'"
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token() }
  if (init?.body !== undefined && init.body !== null) headers['Content-Type'] = 'application/json'
  const res = await fetch('/api' + path, { ...init, headers: { ...headers, ...(init?.headers as any || {}) } })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { message: text } }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status))
  return data
}

function ok(t: string) { msg.type = 'ok'; msg.text = t }
function err(t: string) { msg.type = 'error'; msg.text = t }

function fmtSize(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

function fmtTime(s: string): string {
  if (!s) return '-'
  const d = new Date(s)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const logText = computed(() => (logLines.value.length ? logLines.value.join('\n') : '(暂无日志)'))

const lastBackupText = computed(() => {
  const b = items.value.filter((i) => i.kind === 'backup')
  return b.length ? fmtTime(b[0].mtime) : '从未备份'
})

/**
 * 用 fetch 下载：<a href> 不会带 Authorization 头，直接点会 401。
 * 这里取回 blob 再用临时 a 标签触发保存。
 */
async function download(it: BackupItem) {
  try {
    const res = await fetch('/api/admin/backup/download/' + encodeURIComponent(it.name), {
      headers: { Authorization: 'Bearer ' + token() }
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = it.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch (e: any) {
    err('下载失败: ' + (e?.message || e))
  }
}

async function loadConfig() {
  const c = await req('/admin/backup/config')
  cfg.keepDays = c.keepDays
  cfg.scriptsReady = c.scriptsReady
  cfg.sshKeyReady = !!c.sshKeyReady
  cfg.githubEnabled = !!c.githubEnabled
  cfg.autoBackup = c.autoBackup !== false
  form.autoBackup = c.autoBackup !== false
  if (c.sshKeyReady) await loadPublicKey()
  form.githubEnabled = !!c.githubEnabled
  form.githubRepo = c.githubRepo || ''
  form.githubBranch = c.githubBranch || 'main'
  form.keepDays = Number(c.keepDays ?? 14)
  form.backupTime = c.backupTime || '03:10'
  form.backupTz = c.backupTz || 'Asia/Shanghai'
}

async function loadList() {
  const d = await req('/admin/backup/list')
  items.value = d.items || []
  totalSize.value = d.totalSize || 0
  listSource.value = d.source === 'github' ? 'github' : 'local'
}

async function loadLog() {
  logLoading.value = true
  try {
    const qs: string[] = []
    if (logFrom.value) qs.push('from=' + encodeURIComponent(logFrom.value))
    if (logTo.value) qs.push('to=' + encodeURIComponent(logTo.value))
    const d = await req('/admin/backup/log' + (qs.length ? '?' + qs.join('&') : ''))
    logLines.value = d.lines || []
  } catch (e: any) {
    err('日志加载失败: ' + (e?.message || e))
  } finally {
    logLoading.value = false
  }
}

function logReset() {
  logFrom.value = ''
  logTo.value = ''
  loadLog()
}

async function clearLog() {
  if (!window.confirm('确认清空全部备份日志？此操作不可撤销。')) return
  try {
    await req('/admin/backup/log', { method: 'DELETE' })
    logLines.value = []
    ok('日志已清空')
  } catch (e: any) {
    err('清空失败: ' + (e?.message || e))
  }
}

async function loadAll() {
  loading.value = true
  msg.text = ''
  try {
    await Promise.all([loadConfig(), loadList(), loadLog().catch(() => {})])
  } catch (e: any) {
    err('加载失败: ' + (e?.message || e))
  } finally {
    loading.value = false
  }
}

async function saveConfig() {
  saving.value = true
  msg.text = ''
  try {
    const d = await req('/admin/backup/config', {
      method: 'PUT',
      body: JSON.stringify({
        githubEnabled: form.githubEnabled,
        githubRepo: form.githubRepo,
        githubBranch: form.githubBranch,
        keepDays: form.keepDays,
        backupTime: form.backupTime,
        backupTz: form.backupTz,
        autoBackup: form.autoBackup
      })
    })
    cfg.githubEnabled = !!form.githubEnabled && !!form.githubRepo
    cfg.autoBackup = !!form.autoBackup
    if (d.noChange) ok('没有检测到改动，无需保存')
    else if (Array.isArray(d.warnings) && d.warnings.length) ok('配置已保存；' + d.warnings.join('；'))
    else ok('配置已保存' + (d.scheduleApplied ? '，自动备份时间已更新为 ' + d.scheduleApplied : ''))
    await loadConfig()
  } catch (e: any) {
    err('保存失败: ' + (e?.message || e))
  } finally {
    saving.value = false
  }
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(publicKey.value)
  } catch {
    // 非 https / 无剪贴板权限时的兜底
    const ta = document.createElement('textarea')
    ta.value = publicKey.value
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

async function onUpload(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files && input.files[0]
  if (!file) return
  if (file.size > 64 * 1024 * 1024) {
    err('文件超过 64 MB，请先在本地压缩')
    input.value = ''
    return
  }
  uploading.value = true
  msg.text = ''
  try {
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let bin = ''
    const CH = 0x8000
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)) as any)
    }
    const d = await req('/admin/backup/upload', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, dataBase64: btoa(bin) })
    })
    ok('已上传 ' + d.name + '（' + fmtSize(d.size) + '），可在下面点「导入」')
    await loadList()
  } catch (e: any) {
    err('上传失败: ' + (e?.message || e))
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function loadPublicKey() {
  try {
    const d = await req('/admin/backup/github-key')
    publicKey.value = d.publicKey || ''
  } catch { /* 忽略 */ }
}

async function genSshKey() {
  genKeyBusy.value = true
  msg.text = ''
  try {
    const d = await req('/admin/backup/gen-ssh-key', { method: 'POST', body: '{}' })
    publicKey.value = d.publicKey || ''
    // 只更新密钥状态，绝不重读整份配置 —— 否则会重置用户还没保存的勾选和输入
    cfg.sshKeyReady = true
    ok(d.alreadyExists ? '已有部署密钥，公钥如下' : '部署密钥已生成，请把公钥加到 GitHub 仓库')
  } catch (e: any) {
    err('生成失败: ' + (e?.message || e))
  } finally {
    genKeyBusy.value = false
  }
}

async function runBackup() {
  running.value = true
  msg.text = ''
  try {
    const d = await req('/admin/backup/run', { method: 'POST', body: '{}' })
    ok('备份完成' + (d.log ? '：' + String(d.log).split('\n').slice(-1)[0] : ''))
    await Promise.all([loadList(), loadLog()])
  } catch (e: any) {
    err('备份失败: ' + (e?.message || e))
    await loadLog().catch(() => {})
  } finally {
    running.value = false
  }
}

async function removeBackup(it: BackupItem) {
  if (!window.confirm('确认删除 ' + it.name + ' ？此操作不可撤销。')) return
  try {
    await req('/admin/backup/' + encodeURIComponent(it.name), { method: 'DELETE' })
    ok('已删除 ' + it.name)
    await loadList()
  } catch (e: any) {
    err('删除失败: ' + (e?.message || e))
  }
}

function openImport(it: BackupItem) {
  importTarget.value = it
  importOutput.value = ''
}

async function doImport(mode: 'overwrite' | 'merge') {
  if (!importTarget.value) return
  const tip = mode === 'overwrite'
    ? '覆盖导入会清空现有数据再完整还原！\n\n确认继续？'
    : '新增导入只补充缺失的记录，不动现有数据。\n\n确认继续？'
  if (!window.confirm(tip)) return
  importMode.value = mode
  importing.value = true
  importOutput.value = ''
  try {
    const start = await req('/admin/backup/import', {
      method: 'POST',
      body: JSON.stringify({
        name: importTarget.value.name,
        mode,
        confirm: 'RESTORE'
      })
    })
    if (!start.started) throw new Error('下发失败')
    importOutput.value = '已开始导入（' + mode + '），正在执行…'

    // 导入耗时较长，改成轮询状态，避免长请求被网关掐断成 502
    let done = false
    for (let i = 0; i < 400; i++) {          // 最多等 20 分钟
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const st = await req('/admin/backup/import/status')
        if (st.done) {
          done = true
          importOutput.value = st.detail || (st.ok ? '导入完成' : '导入失败')
          if (st.ok) ok('导入完成（' + mode + '）')
          else err('导入失败，详情见下方输出')
          break
        }
        importOutput.value = '正在导入… 已等待 ' + ((i + 1) * 3) + ' 秒'
      } catch { /* 单次查询失败就继续 */ }
    }
    if (!done) {
      importOutput.value = '等待超时，请查看备份日志确认结果'
      err('等待超时，请查看备份日志')
    }
    await Promise.all([loadList(), loadLog()])
  } catch (e: any) {
    err('导入失败: ' + (e?.message || e))
    importOutput.value = String(e?.message || e)
  } finally {
    importing.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
.bk-wrap { padding: 4px 2px 32px; color: var(--text-primary, #e5e7eb); }
.bk-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.bk-head h2 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
.bk-sub { margin: 0; font-size: 13px; opacity: .65; }
.bk-head-actions { display: flex; gap: 8px; }

.bk-btn { padding: 8px 16px; border-radius: 8px; border: 1px solid transparent; font-size: 13px; cursor: pointer; transition: .15s; }
.bk-btn:disabled { opacity: .5; cursor: not-allowed; }
.bk-btn-primary { background: #3b82f6; color: #fff; }
.bk-btn-primary:hover:not(:disabled) { background: #2563eb; }
.bk-btn-ghost { background: transparent; border-color: rgba(148,163,184,.35); color: inherit; }
.bk-btn-ghost:hover:not(:disabled) { background: rgba(148,163,184,.12); }
.bk-btn-danger { background: #dc2626; color: #fff; }
.bk-btn-danger:hover:not(:disabled) { background: #b91c1c; }

.bk-card { background: rgba(148,163,184,.06); border: 1px solid rgba(148,163,184,.16); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
.bk-card h3 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }

.bk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.bk-stat { display: flex; flex-direction: column; gap: 4px; }
.bk-k { font-size: 12px; opacity: .6; }
.bk-v { font-size: 14px; font-weight: 500; }
.bk-v.ok { color: #22c55e; }
.bk-v.bad { color: #f59e0b; }
.bk-v.off { opacity: .5; }

.bk-row { margin-bottom: 10px; }
.bk-check { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; }
.bk-check input { width: 16px; height: 16px; cursor: pointer; }
.bk-check.is-disabled { opacity: .45; cursor: not-allowed; }
.bk-check.is-disabled input { cursor: not-allowed; }

.bk-fields { display: flex; flex-wrap: wrap; gap: 12px; padding-left: 24px; margin-bottom: 8px; transition: .15s; }
.bk-fields.is-off { opacity: .4; pointer-events: none; }
.bk-field { display: flex; flex-direction: column; gap: 6px; flex: 1 1 320px; min-width: 0; }
.bk-field-sm { flex: 0 0 180px; }
.bk-field-branch { flex: 0 0 120px; }
.bk-fields .bk-field:first-child { flex: 1 1 380px; }
.bk-label { font-size: 12px; opacity: .65; }
.bk-field input[type=text], .bk-field input:not([type]) { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,.28); background: rgba(148,163,184,.08); color: inherit; font-size: 13px; }
.bk-field input:focus, .bk-field select:focus { outline: none; border-color: #3b82f6; }
.bk-field select { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,.28); background: rgba(148,163,184,.08); color: inherit; font-size: 13px; cursor: pointer; }
.bk-field select option { background: #1e293b; color: #e5e7eb; }

.bk-hint { font-size: 12px; opacity: .55; margin: 6px 0 0; line-height: 1.6; }
.bk-hint code { background: rgba(148,163,184,.16); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
.bk-hr { border: none; border-top: 1px solid rgba(148,163,184,.16); margin: 14px 0; }
.bk-actions { margin-top: 14px; display: flex; gap: 8px; }

.bk-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.bk-table th { text-align: left; font-weight: 500; font-size: 12px; opacity: .6; padding: 6px 8px; border-bottom: 1px solid rgba(148,163,184,.16); }
.bk-table td { padding: 8px; border-bottom: 1px solid rgba(148,163,184,.08); vertical-align: middle; }
.bk-mono { font-family: ui-monospace, monospace; font-size: 12px; }
.bk-td-actions { display: flex; gap: 10px; flex-wrap: wrap; }

.bk-tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.bk-tag-ok { background: rgba(34,197,94,.16); color: #22c55e; }
.bk-tag-warn { background: rgba(245,158,11,.16); color: #f59e0b; }

.bk-link { background: none; border: none; padding: 0; font-size: 13px; color: #60a5fa; cursor: pointer; text-decoration: none; }
.bk-link:hover { text-decoration: underline; }
.bk-link-primary { color: #34d399; }
.bk-link-danger { color: #f87171; }

.bk-keybox { padding-left: 24px; margin: 4px 0 8px; }
.bk-keyrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bk-pubkey { position: relative; display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,.28); background: rgba(148,163,184,.08); font-family: ui-monospace, monospace; font-size: 11px; cursor: pointer; transition: .15s; }
.bk-pubkey:hover { border-color: #3b82f6; background: rgba(59,130,246,.08); }
.bk-pubkey.is-copied { border-color: #22c55e; background: rgba(34,197,94,.1); }
.bk-pubkey-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bk-pubkey-tip { flex: 0 0 auto; color: #60a5fa; font-family: inherit; }
.bk-pubkey.is-copied .bk-pubkey-tip { color: #22c55e; }
.bk-upload { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.bk-upload label { cursor: pointer; display: inline-block; }
.bk-key { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(148,163,184,.3); cursor: pointer; transition: .15s; }
.bk-key:hover { border-color: #3b82f6; }
.bk-key.is-copied { border-color: #22c55e; background: rgba(34,197,94,.08); }
.bk-key-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.bk-key-tip { flex: 0 0 auto; font-size: 12px; color: #60a5fa; }
.bk-key.is-copied .bk-key-tip { color: #22c55e; }
.bk-empty { font-size: 13px; opacity: .5; padding: 12px 0; }
.bk-log { background: rgba(148,163,184,.08); border: 1px solid rgba(148,163,184,.16); border-radius: 8px; padding: 14px; font-size: 12.5px; line-height: 1.7; font-family: ui-monospace, monospace; min-height: 420px; max-height: 70vh; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0; }
.bk-log-sm { max-height: 160px; margin-top: 12px; }

.bk-alert { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; display: flex; justify-content: space-between; gap: 12px; }
.bk-alert.is-ok { background: rgba(34,197,94,.14); color: #4ade80; }
.bk-alert.is-error { background: rgba(239,68,68,.14); color: #f87171; }
.bk-x { cursor: pointer; opacity: .6; }


.bk-mode input { margin-top: 3px; }

</style>
