import { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { prisma } from '../db/prisma.js'
import { apiError, ErrorCode } from '../lib/errors.js'

/**
 * 节点延迟探针（广州 / 上海 TCP）
 *
 * 面板自己不在国内，测不出国内到节点的真实延迟，所以由部署在广州/上海的小探针
 * 定期 TCP 连接节点的公网 IP，把「平均延迟 + 丢包率」POST 回来。
 *
 *   GET  /api/latency/probe.sh        下载探针脚本（脚本里已内联面板地址与 token）
 *   GET  /api/latency/targets         探针拉取要测的节点列表（token 鉴权）
 *   POST /api/latency/report          探针上报结果（token 鉴权）
 *   GET  /api/hosts/latency/summary   面板读取最新延迟（登录用户）
 */

const TOKEN_KEY = 'latency_probe_token'
const DEFAULT_PROBES = ['guangzhou', 'shanghai']

async function getProbeToken(): Promise<string> {
  const env = (process.env.LATENCY_PROBE_TOKEN || '').trim()
  if (env) return env
  const row = await prisma.systemConfig.findUnique({ where: { key: TOKEN_KEY } })
  if (row?.value) return row.value
  const token = randomBytes(24).toString('hex')
  await prisma.systemConfig.upsert({
    where: { key: TOKEN_KEY },
    update: {},
    create: { key: TOKEN_KEY, value: token, type: 'secret', label: '延迟探针 Token', description: '广州/上海探针上报延迟用的共享密钥' }
  })
  return token
}

function checkToken(header: unknown, expected: string): boolean {
  const got = String(header || '').trim()
  if (!got || got.length !== expected.length) return false
  // 定长比较，避免时序侧信道
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

function derivePanelUrl(request: { headers: Record<string, unknown> }): string {
  const proto = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '')
  return `${proto}://${host}`.replace(/\/+$/, '')
}

export default async function latencyRoutes(fastify: FastifyInstance): Promise<void> {
  // ---------------- 探针脚本（公开，token 已内联） ----------------
  fastify.get('/api/latency/probe.sh', async (request, reply) => {
    const token = await getProbeToken()
    const panelUrl = derivePanelUrl(request as unknown as { headers: Record<string, unknown> })
    const script = `#!/bin/bash
# Incudal 节点延迟探针（TCP）—— 放在广州/上海任意一台 Linux 上跑
# 安装：curl -fsSL ${panelUrl}/api/latency/probe.sh -o /tmp/probe.sh && sudo bash /tmp/probe.sh install gz
#   gz = 广州（显示为「广州」），sh = 上海（显示为「上海」）
set -uo pipefail
PANEL_URL="\${PANEL_URL:-${panelUrl}}"
TOKEN="\${TOKEN:-${token}}"
PROBE="\${2:-gz}"
ATTEMPTS="\${ATTEMPTS:-5}"
TIMEOUT="\${TIMEOUT:-3}"

case "$PROBE" in
  gz|guangzhou) PROBE_NAME=guangzhou ;;
  sh|shanghai)  PROBE_NAME=shanghai ;;
  *) PROBE_NAME="$PROBE" ;;
esac

fetch_targets() {
  curl -fsSL --max-time 20 -H "X-Probe-Token: $TOKEN" "$PANEL_URL/api/latency/targets?format=text"
}

# 单次 TCP 连接耗时（毫秒），失败输出 -1
tcp_once() {
  local ip="$1" port="$2"
  local start end
  start=$(date +%s%N)
  if timeout "$TIMEOUT" bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null; then
    end=$(date +%s%N)
    echo $(( (end - start) / 1000000 ))
  else
    echo -1
  fi
}

run_once() {
  local json targets
  targets=$(fetch_targets) || { echo "拉取节点列表失败（token 或网络问题）"; return 1; }
  local out='{"probe":"'"$PROBE_NAME"'","results":['
  local first=1
  while IFS='|' read -r hid ip port name; do
    [ -z "$hid" ] && continue
    local ok=0 sum=0 i v
    for ((i=0;i<ATTEMPTS;i++)); do
      v=$(tcp_once "$ip" "$port")
      if [ "$v" -ge 0 ]; then ok=$((ok+1)); sum=$((sum+v)); fi
    done
    local avg loss
    if [ "$ok" -gt 0 ]; then avg=$((sum/ok)); else avg=null; fi
    loss=$(( (ATTEMPTS-ok) * 100 / ATTEMPTS ))
    [ $first -eq 0 ] && out+=','
    out+='{"hostId":'"$hid"',"latencyMs":'"$avg"',"lossPct":'"$loss"',"samples":'"$ATTEMPTS"'}'
    first=0
  done < <(printf '%s\n' "$targets" | grep -E '^[0-9]+\|')
  out+=']}'
  curl -fsSL --max-time 20 -X POST "$PANEL_URL/api/latency/report" \\
    -H "Content-Type: application/json" -H "X-Probe-Token: $TOKEN" -d "$out" >/dev/null \\
    && echo "[$(date '+%F %T')] 上报成功（$PROBE_NAME）" \\
    || echo "[$(date '+%F %T')] 上报失败"
}

install_timer() {
  mkdir -p /opt/incudal-probe
  cp "$0" /opt/incudal-probe/probe.sh 2>/dev/null || true
  chmod +x /opt/incudal-probe/probe.sh
  cat > /etc/systemd/system/incudal-latency-probe.service <<EOF
[Unit]
Description=Incudal latency probe ($PROBE_NAME)
[Service]
Type=oneshot
Environment=PANEL_URL=$PANEL_URL
Environment=TOKEN=$TOKEN
Environment=PROBE=$PROBE_NAME
ExecStart=/bin/bash /opt/incudal-probe/probe.sh run
EOF
  cat > /etc/systemd/system/incudal-latency-probe.timer <<EOF
[Unit]
Description=Run Incudal latency probe every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now incudal-latency-probe.timer >/dev/null 2>&1
  echo "已安装：每分钟探测一次（systemctl status incudal-latency-probe.timer 查看）"
  systemctl start incudal-latency-probe.service
}

case "\${1:-run}" in
  install) install_timer ;;
  run|*)   run_once ;;
esac
`
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(script)
  })

  // ---------------- 探针拉取目标 ----------------
  fastify.get('/api/latency/targets', async (request, reply) => {
    const token = await getProbeToken()
    if (!checkToken(request.headers['x-probe-token'], token)) {
      return reply.code(401).send(apiError(ErrorCode.UNAUTHORIZED, '探针 token 不正确'))
    }
    const hosts = await prisma.host.findMany({
      where: { natPublicIp: { not: null } },
      select: { id: true, name: true, natPublicIp: true },
      orderBy: { id: 'asc' }
    })
    const list = hosts
      .filter(h => h.natPublicIp)
      .map(h => ({ hostId: h.id, name: h.name, ip: h.natPublicIp as string, port: 8443 }))

    // format=text 给 shell 探针用（省掉 json 解析依赖）
    if (String((request.query as { format?: string })?.format || '') === 'text') {
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .send(list.map(h => `${h.hostId}|${h.ip}|${h.port}|${h.name}`).join('\n'))
    }
    return list
  })

  // ---------------- 探针上报 ----------------
  fastify.post<{ Body: { probe?: string; results?: Array<{ hostId: number; latencyMs: number | null; lossPct: number; samples: number }> } }>(
    '/api/latency/report',
    async (request, reply) => {
      const token = await getProbeToken()
      if (!checkToken(request.headers['x-probe-token'], token)) {
        return reply.code(401).send(apiError(ErrorCode.UNAUTHORIZED, '探针 token 不正确'))
      }
      const probe = String(request.body?.probe || '').trim().toLowerCase()
      if (!probe || probe.length > 32 || !/^[a-z0-9_-]+$/.test(probe)) {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, 'probe 名称不合法'))
      }
      const results = Array.isArray(request.body?.results) ? request.body!.results! : []
      if (!results.length) return { ok: true, saved: 0 }

      const rows = results
        .filter(r => Number.isFinite(Number(r.hostId)))
        .map(r => ({
          hostId: Number(r.hostId),
          probe,
          latencyMs: r.latencyMs === null || r.latencyMs === undefined ? null : Math.max(0, Math.min(60000, Number(r.latencyMs))),
          lossPct: Math.max(0, Math.min(100, Number(r.lossPct) || 0)),
          samples: Math.max(0, Math.min(1000, Number(r.samples) || 0))
        }))

      const validHostIds = new Set(
        (await prisma.host.findMany({ where: { id: { in: rows.map(r => r.hostId) } }, select: { id: true } })).map(h => h.id)
      )
      const data = rows.filter(r => validHostIds.has(r.hostId))
      if (data.length) {
        // 数值都已 Number() 化并夹紧过，直接拼字面量（与 traffic.ts 的批量写法一致）
        const valuesClause = data
          .map(r => `(${r.hostId}, '${r.probe}', ${r.latencyMs === null ? 'NULL' : Number(r.latencyMs)}, ${Number(r.lossPct)}, ${Number(r.samples)})`)
          .join(',')
        await prisma.$executeRawUnsafe(
          `INSERT INTO host_latency_samples (host_id, probe, latency_ms, loss_pct, samples) VALUES ${valuesClause}`
        )
        // 只保留 7 天，避免表无限膨胀
        await prisma.$executeRawUnsafe(
          `DELETE FROM host_latency_samples WHERE measured_at < now() - interval '7 days'`
        ).catch(() => undefined)
      }
      return { ok: true, saved: data.length }
    }
  )


  // ---------------- 单个节点的历史曲线 ----------------
  fastify.get<{ Params: { id: string }; Querystring: { minutes?: string } }>(
    '/api/hosts/:id/latency/history',
    { onRequest: [(fastify as any).authenticate] },
    async (request, reply) => {
      const hostId = Number(request.params.id)
      if (!Number.isFinite(hostId)) {
        return reply.code(400).send(apiError(ErrorCode.VALIDATION_ERROR, '节点 ID 不合法'))
      }
      const minutes = Math.max(5, Math.min(7 * 24 * 60, Number(request.query?.minutes) || 60))
      const rows = await prisma.$queryRawUnsafe<Array<{ probe: string; bucket: Date; ms: number | null; loss: number }>>(
        `SELECT probe,
                date_trunc('minute', measured_at) AS bucket,
                avg(latency_ms) AS ms,
                avg(loss_pct)  AS loss
         FROM host_latency_samples
         WHERE host_id = ${hostId} AND measured_at > now() - interval '${minutes} minutes'
         GROUP BY probe, bucket
         ORDER BY bucket ASC`
      )
      const series: Record<string, Array<{ t: string; ms: number | null; loss: number }>> = {}
      for (const r of rows) {
        series[r.probe] = series[r.probe] || []
        series[r.probe].push({
          t: r.bucket.toISOString(),
          ms: r.ms === null ? null : Math.round(Number(r.ms) * 10) / 10,
          loss: Math.round(Number(r.loss))
        })
      }
      return { minutes, probes: Object.keys(series), series }
    }
  )

  // ---------------- 面板读取汇总 ----------------
  fastify.get('/api/hosts/latency/summary', { onRequest: [(fastify as any).authenticate] }, async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ host_id: number; probe: string; latency_ms: number | null; loss_pct: number; measured_at: Date }>>(
      `SELECT DISTINCT ON (host_id, probe) host_id, probe, latency_ms, loss_pct, measured_at
       FROM host_latency_samples
       WHERE measured_at > now() - interval '30 minutes'
       ORDER BY host_id, probe, measured_at DESC`
    )
    const out: Record<string, Record<string, { latencyMs: number | null; lossPct: number; at: string }>> = {}
    for (const r of rows) {
      out[r.host_id] = out[r.host_id] || {}
      out[r.host_id][r.probe] = {
        latencyMs: r.latency_ms === null ? null : Math.round(Number(r.latency_ms)),
        lossPct: Math.round(Number(r.loss_pct)),
        at: r.measured_at.toISOString()
      }
    }
    return { probes: DEFAULT_PROBES, hosts: out }
  })
}
