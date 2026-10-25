<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 节点 → 中国大陆三网 延迟曲线
 *
 * 数据来自节点上的 agent：节点自己 TCP 探测
 *   广东/上海 × 联通(cu)/移动(cm)/电信(ct) × IPv4/IPv6
 * 的 CDN 探测点（zstaticcdn:80），上报后按 probe key（gd-cu-v4 …）存库。
 *
 * 纯 SVG 绘制，不引第三方图表库。
 */

interface Point { t: string; ms: number | null; loss: number }

const props = withDefaults(defineProps<{
  series: Record<string, Point[]>
  height?: number
  /** 当前选择的时间窗口（分钟）：X 轴固定铺满这个窗口，而不是只铺数据范围 */
  windowMinutes?: number
  loading?: boolean
}>(), {
  height: 300,
  windowMinutes: 60,
  loading: false
})

// 宽度跟随容器（ResizeObserver），高度固定，图就能拉满整张卡片
const wrapRef = ref<HTMLElement | null>(null)
const W = ref(640)
let ro: ResizeObserver | null = null

onMounted(() => {
  if (!wrapRef.value) return
  const apply = () => { W.value = Math.max(320, Math.round(wrapRef.value!.clientWidth)) }
  apply()
  ro = new ResizeObserver(apply)
  ro.observe(wrapRef.value)
})

onBeforeUnmount(() => { ro?.disconnect(); ro = null })

const H = computed(() => props.height)
const PAD = { top: 14, right: 12, bottom: 22, left: 38 }

const CITY_META: Record<string, string> = { gd: '广东', sh: '上海' }
const ISP_META: Record<string, { label: string; color: string }> = {
  cu: { label: '联通', color: '#ef4444' },
  cm: { label: '移动', color: '#3b82f6' },
  ct: { label: '电信', color: '#10b981' }
}

const city = ref<'gd' | 'sh'>('gd')
const family = ref<'v4' | 'v6'>('v4')

/** 有哪些协议族真的有数据 */
const availableFamilies = computed(() => {
  const set = new Set<string>()
  for (const key of Object.keys(props.series)) {
    if (props.series[key]?.length) set.add(key.split('-')[2])
  }
  return ['v4', 'v6'].filter(f => set.has(f))
})

const activeFamily = computed<'v4' | 'v6'>(() => {
  if (availableFamilies.value.includes(family.value)) return family.value
  return (availableFamilies.value[0] as 'v4' | 'v6') || 'v4'
})

const activeProbes = computed(() => (['cu', 'cm', 'ct'] as const).map(isp => ({
  key: `${city.value}-${isp}-${activeFamily.value}`,
  label: ISP_META[isp].label,
  color: ISP_META[isp].color
})))

/** 某个协议族在当前城市下是否有成功采样 */
function familyHasData(f: string): boolean {
  return (['cu', 'cm', 'ct'] as const).some(isp =>
    (props.series[`${city.value}-${isp}-${f}`] || []).some(pt => pt.ms !== null)
  )
}

// 默认落在「有数据」的协议族上：v4 探测点不通时自动切到 v6，避免一进来就是空图
watch([() => props.series, city], () => {
  if (familyHasData(family.value)) return
  const better = availableFamilies.value.find(f => familyHasData(f))
  if (better && better !== family.value) family.value = better as 'v4' | 'v6'
}, { deep: true, immediate: true })

const hoverIndex = ref<number | null>(null)

const timeAxis = computed(() => {
  const set = new Set<number>()
  for (const p of activeProbes.value) for (const pt of props.series[p.key] || []) set.add(new Date(pt.t).getTime())
  return Array.from(set).sort((a, b) => a - b)
})

const hasData = computed(() =>
  activeProbes.value.some(p => (props.series[p.key] || []).some(pt => pt.ms !== null))
)

/** 有采样点但全部拿不到延迟（探测点不可达） */
const allTimedOut = computed(() =>
  !hasData.value && activeProbes.value.some(p => (props.series[p.key] || []).length > 0)
)

const emptyHint = computed(() => {
  if (props.loading) return '加载中…'
  if (allTimedOut.value) {
    const other = activeFamily.value === 'v4' ? 'IPv6' : 'IPv4'
    return availableFamilies.value.length > 1
      ? `该节点 ${activeFamily.value.toUpperCase()} 探测点全部超时，可切换到 ${other} 查看`
      : `该节点 ${activeFamily.value.toUpperCase()} 探测点全部超时（探测点不可达）`
  }
  return '该时间窗口内没有数据'
})

const maxMs = computed(() => {
  let max = 0
  for (const p of activeProbes.value) {
    for (const pt of props.series[p.key] || []) if (pt.ms !== null) max = Math.max(max, pt.ms)
  }
  if (max <= 0) return 100
  const steps = [50, 100, 150, 200, 300, 400, 500, 800, 1000, 1500, 2000, 3000]
  return steps.find(s => s >= max * 1.15) || Math.ceil((max * 1.2) / 500) * 500
})

const plotW = computed(() => W.value - PAD.left - PAD.right)
const plotH = computed(() => H.value - PAD.top - PAD.bottom)

/** 窗口右边界：数据里最新的时间或当前时间，取较晚者 */
const windowEnd = computed(() => {
  const axis = timeAxis.value
  const lastData = axis.length ? axis[axis.length - 1] : 0
  return Math.max(Date.now(), lastData)
})

const windowStart = computed(() => windowEnd.value - props.windowMinutes * 60 * 1000)

function xOf(ts: number): number {
  const span = windowEnd.value - windowStart.value
  if (span <= 0) return PAD.left
  const ratio = (ts - windowStart.value) / span
  return PAD.left + Math.max(0, Math.min(1, ratio)) * plotW.value
}

function yOf(ms: number): number {
  return PAD.top + plotH.value - (Math.min(ms, maxMs.value) / maxMs.value) * plotH.value
}

/** 每条线拆段：超时点断线，超过 3 分钟没数据也断开 */
const lines = computed(() => activeProbes.value.map(p => {
  const segments: string[] = []
  let cur: string[] = []
  let lastTs = 0
  for (const pt of props.series[p.key] || []) {
    const ts = new Date(pt.t).getTime()
    if (pt.ms === null) {
      if (cur.length > 1) segments.push(cur.join(' '))
      cur = []
    } else {
      if (cur.length && ts - lastTs > 3 * 60 * 1000) { segments.push(cur.join(' ')); cur = [] }
      cur.push(`${xOf(ts).toFixed(1)},${yOf(pt.ms).toFixed(1)}`)
    }
    lastTs = ts
  }
  if (cur.length > 1) segments.push(cur.join(' '))
  return { ...p, segments }
}))

const stats = computed(() => activeProbes.value.map(p => {
  const raw = props.series[p.key] || []
  const arr = raw.filter(x => x.ms !== null) as Array<Point & { ms: number }>
  const losses = raw.map(x => x.loss)
  const avgLoss = losses.length ? Math.round(losses.reduce((a, b) => a + b, 0) / losses.length) : 0
  // 有采样点但全部拿不到延迟 = 全部超时（探测点不可达），和无数据不是一回事
  if (!arr.length) return { ...p, avg: null, max: null, loss: avgLoss, allTimeout: raw.length > 0 }
  return {
    ...p,
    avg: Math.round(arr.reduce((a, b) => a + b.ms, 0) / arr.length),
    max: Math.round(Math.max(...arr.map(a => a.ms))),
    loss: avgLoss
  }
}))

const yTicks = computed(() => {
  const n = 4
  return Array.from({ length: n + 1 }, (_, i) => Math.round((maxMs.value / n) * i))
})

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const xLabels = computed(() => {
  const n = Math.min(7, Math.max(3, Math.round(W.value / 110)))
  const span = windowEnd.value - windowStart.value
  const step = span / (n - 1)
  return Array.from({ length: n }, (_, i) => {
    const ts = windowStart.value + step * i
    const d = new Date(ts)
    const text = props.windowMinutes >= 1440
      ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}时`
      : fmtTime(d.toISOString())
    return { x: xOf(ts), text }
  })
})

/** 窗口起止说明 */
const windowCaption = computed(() => {
  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${fmt(windowStart.value)} ~ ${fmt(windowEnd.value)}`
})

const hoverInfo = computed(() => {
  if (hoverIndex.value === null) return null
  const axis = timeAxis.value
  const ts = axis[hoverIndex.value]
  if (!ts) return null
  const rows = activeProbes.value.map(p => {
    const pt = (props.series[p.key] || []).find(x => new Date(x.t).getTime() === ts)
    return {
      label: p.label,
      color: p.color,
      ms: pt?.ms ?? null,
      loss: pt?.loss ?? null,
      y: pt?.ms === null || pt?.ms === undefined ? null : yOf(pt.ms)
    }
  })
  return { time: fmtTime(new Date(ts).toISOString()), x: xOf(ts), rows }
})

function onMove(evt: MouseEvent) {
  const axis = timeAxis.value
  if (!axis.length) return
  const rect = (evt.currentTarget as SVGElement).getBoundingClientRect()
  const x = ((evt.clientX - rect.left) / rect.width) * W.value
  let best = 0, bestD = Infinity
  axis.forEach((ts, i) => {
    const d = Math.abs(xOf(ts) - x)
    if (d < bestD) { bestD = d; best = i }
  })
  hoverIndex.value = best
}
</script>

<template>
  <div ref="wrapRef" class="w-full">
    <!-- 城市 / 协议切换 -->
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1">
        <button
          v-for="(label, key) in CITY_META" :key="key"
          class="rounded-md px-2.5 py-1 text-xs transition-colors"
          :class="city === key ? 'bg-blue-500/15 text-blue-500 font-medium' : 'text-themed-muted hover:bg-white/5'"
          @click="city = key as 'gd' | 'sh'"
        >{{ label }}</button>
      </div>
      <div v-if="availableFamilies.length > 1" class="flex items-center gap-1">
        <button
          v-for="f in availableFamilies" :key="f"
          class="rounded-md px-2.5 py-1 text-xs transition-colors"
          :class="activeFamily === f ? 'bg-blue-500/15 text-blue-500 font-medium' : 'text-themed-muted hover:bg-white/5'"
          @click="family = f as 'v4' | 'v6'"
        >{{ f === 'v4' ? 'IPv4' : 'IPv6' }}</button>
      </div>
      <span v-else-if="availableFamilies.length === 1" class="text-[11px] text-themed-muted">
        节点仅支持 {{ availableFamilies[0] === 'v4' ? 'IPv4' : 'IPv6' }}
      </span>
    </div>

    <!-- 统计 -->
    <div class="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      <div v-for="s in stats" :key="s.key" class="flex items-center gap-1.5">
        <span class="inline-block h-2 w-2 rounded-full" :style="{ background: s.color }"></span>
        <span class="text-themed-secondary">{{ s.label }}</span>
        <template v-if="s.avg !== null">
          <span class="font-medium text-themed">{{ s.avg }} ms</span>
          <span class="text-themed-muted">峰 {{ s.max }}</span>
          <span v-if="s.loss" class="text-red-500">丢包 {{ s.loss }}%</span>
          <span v-else class="text-emerald-500">无丢包</span>
        </template>
        <span v-else-if="s.allTimeout" class="text-red-500">全部超时（探测点不可达）</span>
        <span v-else class="text-themed-muted">暂无数据</span>
      </div>
    </div>

    <div class="relative">
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        class="w-full select-none"
        :style="{ height: `${H}px` }"
        @mousemove="onMove"
        @mouseleave="hoverIndex = null"
      >
        <g v-for="(tick, i) in yTicks" :key="`y${i}`">
          <line
            :x1="PAD.left" :x2="W - PAD.right"
            :y1="PAD.top + plotH - (tick / maxMs) * plotH"
            :y2="PAD.top + plotH - (tick / maxMs) * plotH"
            stroke="currentColor" stroke-width="0.5" class="text-themed-border" opacity="0.35"
          />
          <text
            :x="PAD.left - 6" :y="PAD.top + plotH - (tick / maxMs) * plotH + 3"
            text-anchor="end" font-size="9" fill="currentColor" class="text-themed-muted"
          >{{ tick }}</text>
        </g>

        <text
          v-for="(l, i) in xLabels" :key="`x${i}`"
          :x="l.x" :y="H - 6" text-anchor="middle" font-size="9"
          fill="currentColor" class="text-themed-muted"
        >{{ l.text }}</text>

        <g v-for="l in lines" :key="l.key">
          <polyline
            v-for="(seg, i) in l.segments" :key="`${l.key}-${i}`"
            :points="seg" fill="none" :stroke="l.color" stroke-width="1.6"
            stroke-linejoin="round" stroke-linecap="round" opacity="0.9"
          />
        </g>

        <line
          v-if="hoverInfo"
          :x1="hoverInfo.x" :x2="hoverInfo.x" :y1="PAD.top" :y2="PAD.top + plotH"
          stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" class="text-themed-muted" opacity="0.6"
        />
        <g v-if="hoverInfo">
          <circle
            v-for="r in hoverInfo.rows" :key="`dot-${r.label}`"
            v-show="r.y !== null"
            :cx="hoverInfo.x" :cy="r.y ?? 0" r="3.2"
            :fill="r.color" stroke="#fff" stroke-width="1.2"
          />
        </g>

        <text
          v-if="!hasData" :x="W / 2" :y="PAD.top + plotH / 2" text-anchor="middle"
          font-size="11" fill="currentColor" class="text-themed-muted"
        >{{ emptyHint }}</text>
      </svg>

      <div
        v-if="hoverInfo"
        class="pointer-events-none absolute top-1 z-10 rounded-md border border-themed bg-themed px-2 py-1 text-[11px] shadow-sm"
        :style="{ left: `calc(${(hoverInfo.x / W) * 100}% + 6px)`, transform: hoverInfo.x > W * 0.7 ? 'translateX(-110%)' : 'none' }"
      >
        <div class="mb-0.5 text-themed-muted">{{ hoverInfo.time }}</div>
        <div v-for="r in hoverInfo.rows" :key="r.label" class="flex items-center gap-1.5">
          <span class="inline-block h-1.5 w-1.5 rounded-full" :style="{ background: r.color }"></span>
          <span class="text-themed-secondary">{{ r.label }}</span>
          <span class="font-medium text-themed">{{ r.ms === null ? '超时' : `${r.ms} ms` }}</span>
          <span v-if="r.loss" class="text-red-500">{{ r.loss }}%</span>
        </div>
      </div>
    </div>

    <div class="mt-1 flex items-center justify-between text-[10px] text-themed-faint">
      <span>{{ windowCaption }}</span>
      <span v-if="loading">刷新中…</span>
    </div>
  </div>
</template>
