import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, Register, RenderChildren, TextProps, TurnCompleteInput } from 'claude-code'

import type { WorkloadMetric, WorkloadRange, WorkloadView } from '../types'

// One project's activity on one day, stored under `day:YYYY-MM-DD`
export type ProjectDay = {
  activeMs: number
  turns: number
  tokens: number
  tools: number
  sessions: string[]
  hours: number[]
}

export type DayLog = Record<string, ProjectDay>

// One bar of a column chart: a label under it and a stacked part per project
type Column = { label: string; parts: { name: string; value: number }[] }

const PANE = 'workload'
const HOUR = 3_600_000
const DAY_PREFIX = 'day:'
const COLORS_KEY = 'colors'
const ALL = '*'
const SPANS: Record<WorkloadRange, number> = { day: 1, week: 7, month: 30 }
const METRICS: { id: WorkloadMetric; label: string; hotkey: string }[] = [
  { id: 'time', label: 'Time', hotkey: '1' },
  { id: 'tokens', label: 'Tokens', hotkey: '2' },
  { id: 'turns', label: 'Turns', hotkey: '3' },
  { id: 'tools', label: 'Tools', hotkey: '4' },
]
const RANGES: { id: WorkloadRange; label: string; hotkey: string }[] = [
  { id: 'day', label: 'Day', hotkey: 'd' },
  { id: 'week', label: 'Week', hotkey: 'w' },
  { id: 'month', label: '30 days', hotkey: 'm' },
]

// Stats table columns; `tip` is the hover explanation of the column name
const STAT_COLUMNS: { id: string; label: string; tip: string }[] = [
  { id: 'project', label: 'Project', tip: 'Git repository root folder name, or the session folder outside git' },
  { id: 'time', label: 'Time', tip: "Claude's working time: wall-clock length of main conversation turns, waits for permission prompts included. Not your own time." },
  { id: 'share', label: 'Share', tip: "This project's part of the period's total working time" },
  { id: 'turns', label: 'Turns', tip: 'Prompts Claude answered in the main conversation' },
  { id: 'tokens', label: 'Tokens', tip: 'Input, output and cache tokens, subagents included' },
  { id: 'tools', label: 'Tools', tip: 'Tool calls made by Claude and its subagents' },
  { id: 'sessions', label: 'Sessions', tip: 'Distinct Claude Code sessions with at least one turn on this project' },
  { id: 'peak', label: 'Peak', tip: 'Hour of the day with the most working time' },
]
const TIP_BG = '#2b2b29'
const TIP_FG = '#f2f1ec'

// Validated categorical palette, one fixed slot per project; past 8, projects share "other"
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const OTHER_LIGHT = '#a3a29c'
const OTHER_DARK = '#6b6a65'
// Sequential blue ramp for the terminal heatmap, near zero to max
const HEAT = ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab']
const SHADES = ['░', '▒', '▓', '█']

const view = atom({ plugin: 'workload', key: 'view' } as const, {
  range: 'day',
  offset: 0,
  metric: 'time',
  project: null,
} as WorkloadView)
const rev = atom({ plugin: 'workload', key: 'rev' } as const, 0)

const pad2 = (n: number) => String(n).padStart(2, '0')

export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const startOfHour = (t: number) => {
  const d = new Date(t)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

// Splits [start, end) into per-day, per-hour pieces in local time
export const slices = (start: number, end: number) => {
  const out: { day: string; hour: number; ms: number }[] = []
  let t = start
  while (t < end) {
    const next = Math.min(end, startOfHour(t) + HOUR)
    out.push({ day: dayKey(t), hour: new Date(t).getHours(), ms: next - t })
    t = next
  }
  return out
}

const emptyProject = (): ProjectDay => ({
  activeMs: 0,
  turns: 0,
  tokens: 0,
  tools: 0,
  sessions: [],
  hours: Array.from({ length: 24 }, () => 0),
})

const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const projectOf = async ($: EngineInterface) => {
  const repo = await $.session.repo().catch(() => null)
  return basename(repo?.root ?? (await $.session.root()))
}

const loadDay = async ($: EngineInterface, day: string) => ((await $.store.get(DAY_PREFIX + day)) ?? {}) as DayLog

const loadSlots = async ($: EngineInterface) => ((await $.store.get(COLORS_KEY)) ?? {}) as Record<string, number>

const metricOf = (p: ProjectDay, metric: WorkloadMetric) =>
  metric === 'time' ? p.activeMs : metric === 'tokens' ? p.tokens : metric === 'turns' ? p.turns : p.tools

export const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return `${Math.round(ms / 1000)}s`
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${pad2(m % 60)}`
}

export const fmtCount = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))

const fmtMetric = (n: number, metric: WorkloadMetric) => (metric === 'time' ? fmtDuration(n) : fmtCount(n))

const merge = (into: ProjectDay, from: ProjectDay) => {
  into.activeMs += from.activeMs
  into.turns += from.turns
  into.tokens += from.tokens
  into.tools += from.tools
  for (const s of from.sessions) if (!into.sessions.includes(s)) into.sessions.push(s)
  from.hours.forEach((ms, h) => (into.hours[h] = (into.hours[h] ?? 0) + ms))
}

const hourLabel = (h: number) => `${pad2(h)}h`

const peakHour = (hours: number[]) => hours.reduce((best, ms, h) => (ms > (hours[best] ?? 0) ? h : best), 0)

const weekday = (day: string) => new Date(`${day}T12:00:00`).toDateString().slice(0, 3)

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}.` : s)

// SVG theme: text in neutral ink, series in the palette, dark steps under a dark scheme
const SVG_STYLE = `<style>
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.l{font-size:12px;fill:#52514e}.v{font-size:12px;fill:#0b0b0b}.a{font-size:11px;fill:#8a8984}
.g{stroke:#e4e3df;stroke-width:1}.b{stroke:#c9c8c2;stroke-width:1}.hit{fill:transparent}.hit:hover{fill:rgba(128,128,128,.08)}
${SERIES_LIGHT.map((c, i) => `.s${i}{fill:${c}}`).join('')}.so{fill:${OTHER_LIGHT}}
@media (prefers-color-scheme:dark){.l{fill:#c3c2b7}.v{fill:#fff}.a{fill:#8f8e88}.g{stroke:#30302e}.b{stroke:#4a4a46}
${SERIES_DARK.map((c, i) => `.s${i}{fill:${c}}`).join('')}.so{fill:${OTHER_DARK}}}
</style>`

const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${SVG_STYLE}${body}</svg>`

// Horizontal bar, square at the baseline, rounded at the data end
const hbar = (x: number, y: number, w: number, h: number, cls: string) => {
  const r = Math.min(4, w / 2, h / 2)
  if (w <= 0) return ''
  return `<path class="${cls}" d="M${x} ${y}h${w - r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${r - w}z"/>`
}

// Vertical segment; only the top one of a stack is rounded
const vbar = (x: number, y: number, w: number, h: number, cls: string, isTop: boolean) => {
  if (h <= 0) return ''
  if (!isTop) return `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`
  const r = Math.min(4, w / 2, h)
  return `<path class="${cls}" d="M${x} ${y + h}v${r - h}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - r}z"/>`
}

const shareSvg = (
  rows: { name: string; value: number; pct: number }[],
  w: number,
  cls: (name: string) => string,
  metric: WorkloadMetric,
) => {
  const rowH = 28
  const nameW = Math.min(170, Math.round(w * 0.32))
  const valueW = 92
  const barX = nameW + 10
  const barMax = Math.max(20, w - barX - valueW - 8)
  const top = Math.max(1, ...rows.map(r => r.value))
  const body = rows
    .map((r, i) => {
      const y = i * rowH
      const bw = r.value > 0 ? Math.max(3, (r.value / top) * barMax) : 0
      const tip = `${r.name}: ${fmtMetric(r.value, metric)} (${r.pct}%)`
      return (
        `<g><title>${esc(tip)}</title><rect class="hit" x="0" y="${y}" width="${w}" height="${rowH}"/>` +
        `<text class="l" x="0" y="${y + 18}">${esc(clip(r.name, Math.floor(nameW / 7)))}</text>` +
        hbar(barX, y + 8, bw, 12, cls(r.name)) +
        `<text class="v" x="${w - 40}" y="${y + 18}" text-anchor="end">${fmtMetric(r.value, metric)}</text>` +
        `<text class="a" x="${w}" y="${y + 18}" text-anchor="end">${r.pct}%</text></g>`
      )
    })
    .join('')
  return svgDoc(w, rows.length * rowH, body)
}

// A round gridline step giving at most 3 lines over `max`
export const niceStep = (max: number, isTime: boolean) => {
  const raw = max / 3
  const steps = isTime
    ? [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720].map(m => m * 60_000)
    : [1, 2, 2.5, 5].flatMap(f => [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8].map(p => f * p)).sort((a, b) => a - b)
  return steps.find(st => st >= raw) ?? raw
}

const columnsSvg = (
  columns: Column[],
  order: string[],
  w: number,
  cls: (name: string) => string,
  fmt: (n: number) => string,
  labelEvery: number,
  isTime: boolean,
) => {
  const legendH = order.length > 1 ? 26 : 0
  const plotTop = legendH + 8
  const plotH = 150
  const axisW = 46
  const h = plotTop + plotH + 22
  const plotW = w - axisW
  const colW = plotW / Math.max(1, columns.length)
  const barW = Math.max(3, Math.min(28, colW * 0.64))
  const totals = columns.map(c => c.parts.reduce((s, p) => s + p.value, 0))
  const step = niceStep(Math.max(1, ...totals), isTime)
  const max = step * Math.max(1, Math.ceil(Math.max(1, ...totals) / step))
  const base = plotTop + plotH

  let legend = ''
  let lx = 0
  for (const name of order) {
    const label = clip(name, 22)
    legend += `<rect class="${cls(name)}" x="${lx}" y="6" width="10" height="10" rx="2"/><text class="l" x="${lx + 15}" y="15">${esc(label)}</text>`
    lx += 15 + label.length * 7 + 16
    if (lx > w - 60) break
  }

  const grid = Array.from({ length: Math.round(max / step) }, (_, i) => (i + 1) * step)
    .map(n => {
      const y = base - (n / max) * plotH
      return `<line class="g" x1="${axisW}" x2="${w}" y1="${y}" y2="${y}"/><text class="a" x="${axisW - 6}" y="${y + 4}" text-anchor="end">${fmt(n)}</text>`
    })
    .join('')

  const bars = columns
    .map((c, i) => {
      const x = axisW + i * colW + (colW - barW) / 2
      const parts = order.map(name => ({ name, value: c.parts.find(p => p.name === name)?.value ?? 0 })).filter(p => p.value > 0)
      const tip = [`${c.label}: ${fmt(totals[i] ?? 0)}`, ...parts.map(p => `${p.name}: ${fmt(p.value)}`)].join('\n')
      let y = base
      const segs = parts
        .map((p, j) => {
          const full = (p.value / max) * plotH
          const segH = Math.max(1, full - (j > 0 ? 2 : 0))
          y -= full
          return vbar(x, y + (full - segH), barW, segH, cls(p.name), j === parts.length - 1)
        })
        .join('')
      const label =
        i % labelEvery === 0
          ? `<text class="a" x="${axisW + i * colW + colW / 2}" y="${base + 16}" text-anchor="middle">${esc(c.label)}</text>`
          : ''
      return `<g><title>${esc(tip)}</title><rect class="hit" x="${axisW + i * colW}" y="${plotTop}" width="${colW}" height="${plotH}"/>${segs}</g>${label}`
    })
    .join('')

  return svgDoc(w, h, `${legend}${grid}<line class="b" x1="${axisW}" x2="${w}" y1="${base}" y2="${base}"/>${bars}`)
}

// Tool calls of the running turn, written when the main turn completes
let pendingTools = 0
// Serialises read-modify-write cycles on the store within this session
let queue: Promise<unknown> = Promise.resolve()

async function edit($: EngineInterface, day: string, project: string, fn: (p: ProjectDay) => void) {
  const run = async () => {
    const log = await loadDay($, day)
    const entry = { ...emptyProject(), ...log[project] }
    fn(entry)
    log[project] = entry
    await $.store.set(DAY_PREFIX + day, log)
  }
  queue = queue.then(run, run)
  return queue
}

// Gives a project its color slot the first time it is seen, so it keeps it everywhere
async function ensureSlot($: EngineInterface, project: string) {
  const run = async () => {
    const slots = await loadSlots($)
    if (slots[project] !== undefined) return
    slots[project] = Object.keys(slots).length
    await $.store.set(COLORS_KEY, slots)
  }
  queue = queue.then(run, run)
  return queue
}

async function bumpRev($: EngineInterface) {
  await update($, rev, n => (n ?? 0) + 1)
}

async function recordTurn($: EngineInterface, e: TurnCompleteInput) {
  const now = await $.clock.now()
  const project = await projectOf($)
  const u = e.usage
  const tokens = u
    ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    : 0

  await ensureSlot($, project)

  if (e.agentId !== undefined) {
    if (tokens > 0) await edit($, dayKey(now), project, p => (p.tokens += tokens))
    return
  }

  const session = await $.session.id()
  const tools = pendingTools
  pendingTools = 0
  const byDay = new Map<string, { hour: number; ms: number }[]>()
  for (const s of slices(now - e.durationMs, now)) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s])
  const today = dayKey(now)
  if (!byDay.has(today)) byDay.set(today, [])

  for (const [day, parts] of byDay) {
    await edit($, day, project, p => {
      for (const { hour, ms } of parts) {
        p.activeMs += ms
        p.hours[hour] = (p.hours[hour] ?? 0) + ms
      }
      if (!p.sessions.includes(session)) p.sessions.push(session)
      if (day === today) {
        p.turns += 1
        p.tokens += tokens
        p.tools += tools
      }
    })
  }
}

async function prune($: EngineInterface, retentionDays: number) {
  const cutoff = dayKey((await $.clock.now()) - retentionDays * 24 * HOUR)
  for (const key of await $.store.keys()) {
    if (key.startsWith(DAY_PREFIX) && key.slice(DAY_PREFIX.length) < cutoff) await $.store.delete(key)
  }
}

export const register: Register = (on, options) => {
  const retentionDays = typeof options.retentionDays === 'number' ? options.retentionDays : 120

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'some-workload',
      description: 'Show the load across your projects in a pane',
    })
    await prune($, retentionDays)
    return next(e)
  })

  on('command.run', { command: 'some-workload' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Workload' })
    return { text: 'Workload pane opened.' }
  })

  on('tool.call', ($, e, next) => {
    pendingTools += 1
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await recordTurn($, e)
    await bumpRev($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, rev)
    const v = await read($, view)
    const now = await $.clock.now()
    const span = SPANS[v.range]
    const anchor = now - v.offset * span * 24 * HOUR
    const days = Array.from({ length: span }, (_, i) => dayKey(anchor - (span - 1 - i) * 24 * HOUR))
    const logs = await Promise.all(days.map(d => loadDay($, d)))
    const stored = await loadSlots($)
    const cols = Math.max(40, e.props.bodyColumns)

    // Every project keeps one color slot; ones never recorded with a slot take the next free ones
    const allProjects = [...new Set(logs.flatMap(l => Object.keys(l)))].sort()
    const slots = { ...stored }
    for (const name of allProjects) if (slots[name] === undefined) slots[name] = Object.keys(slots).length
    const slotOf = (name: string) => {
      const s = slots[name] ?? 99
      return s < SERIES_LIGHT.length ? s : -1
    }
    const keep = (name: string) => v.project === null || v.project === name

    const totals = new Map<string, ProjectDay>()
    for (const log of logs) {
      for (const [name, p] of Object.entries(log)) {
        if (!keep(name)) continue
        const t = totals.get(name) ?? emptyProject()
        merge(t, { ...emptyProject(), ...p })
        totals.set(name, t)
      }
    }
    const all = emptyProject()
    for (const p of totals.values()) merge(all, p)
    const ranked = [...totals.entries()].sort((a, b) => metricOf(b[1], v.metric) - metricOf(a[1], v.metric))
    const order = ranked.map(([name]) => name)
    const grand = metricOf(all, v.metric)
    const pctOf = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0)

    const set = (patch: Partial<WorkloadView>) => () => void update($, view, cur => ({ ...cur, ...patch }))
    const mode = {
      day: { title: 'Daily split', unit: 'day', current: 'Today' },
      week: { title: 'Weekly split', unit: 'week', current: 'This week' },
      month: { title: '30-day split', unit: '30 days', current: 'Last 30 days' },
    }[v.range]
    const short = (day: string) => `${weekday(day)} ${new Date(`${day}T12:00:00`).toDateString().slice(4, 10)}`
    const period =
      span === 1
        ? `${new Date(anchor).toDateString()}${v.offset === 0 ? ' (today)' : ''}`
        : `${short(days[0] ?? '')} to ${short(days[days.length - 1] ?? '')}${v.offset === 0 ? ` (${mode.current.toLowerCase()})` : ''}`
    const pickProject = (value: string) => void update($, view, cur => ({ ...cur, project: value === ALL ? null : value }))

    const activeHours = all.hours.map((ms, hr) => (ms > 0 ? hr : -1)).filter(hr => hr >= 0)
    const kpis = [
      { label: 'active', value: fmtDuration(all.activeMs) },
      { label: 'turns', value: fmtCount(all.turns) },
      { label: 'tokens', value: fmtCount(all.tokens) },
      { label: 'tool calls', value: fmtCount(all.tools) },
      { label: 'sessions', value: String(all.sessions.length) },
      { label: 'projects', value: String(ranked.length) },
    ]
    const rhythm =
      activeHours.length > 0
        ? `First activity ${hourLabel(activeHours[0] ?? 0)}, last ${hourLabel(activeHours[activeHours.length - 1] ?? 0)}, peak ${hourLabel(peakHour(all.hours))}`
        : ''

    // Day: active time by hour; week and 30 days: chosen metric by day
    const byHour = span === 1
    const columns: Column[] = byHour
      ? Array.from({ length: 24 }, (_, hr) => ({
          label: pad2(hr),
          parts: ranked.map(([name, p]) => ({ name, value: p.hours[hr] ?? 0 })),
        }))
      : days.map((day, i) => ({
          label: span === 7 ? `${weekday(day)} ${day.slice(8)}` : day.slice(5),
          parts: Object.entries(logs[i] ?? {})
            .filter(([name]) => keep(name))
            .map(([name, p]) => ({ name, value: metricOf({ ...emptyProject(), ...p }, v.metric) })),
        }))
    const columnsTitle = byHour ? 'Active time by hour' : `${METRICS.find(m => m.id === v.metric)?.label ?? ''} by day`
    const columnsFmt = (n: number) => (byHour ? fmtDuration(n) : fmtMetric(n, v.metric))
    const shareTitle = `Share of ${(METRICS.find(m => m.id === v.metric)?.label ?? '').toLowerCase()} by project`

    const statRows = ranked.map(([name, p]) => [
      name,
      fmtDuration(p.activeMs),
      `${pctOf(p.activeMs, all.activeMs)}%`,
      fmtCount(p.turns),
      fmtCount(p.tokens),
      fmtCount(p.tools),
      String(p.sessions.length),
      p.activeMs > 0 ? hourLabel(peakHour(p.hours)) : '-',
    ])
    const statNameW = Math.min(24, Math.max(8, ...order.map(n => n.length)) + 1)

    // A table whose column names reveal their explanation on hover
    const statsTable = (Box: ElementConstructor<BoxProps>, Text: ElementConstructor<TextProps>) => (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {STAT_COLUMNS.map((c, i) => (
            <Box key={`col-${c.id}`} width={i === 0 ? statNameW : 9} justifyContent={i === 0 ? 'flex-start' : 'flex-end'}>
              <Text bold underline>{c.label}</Text>
              <Box
                position="absolute"
                top={1}
                {...(i < STAT_COLUMNS.length / 2 ? { left: 0 } : { right: 0 })}
                width={34}
                display="none"
                hover={{ display: 'flex' }}
                backgroundColor={TIP_BG}
                paddingX={1}
              >
                <Text color={TIP_FG} wrap="wrap">{c.tip}</Text>
              </Box>
            </Box>
          ))}
        </Box>
        {statRows.map(row => (
          <Box key={`stat-${row[0]}`} flexDirection="row">
            {row.map((cell, i) => (
              <Box key={`stat-${row[0]}-${i}`} width={i === 0 ? statNameW : 9} justifyContent={i === 0 ? 'flex-start' : 'flex-end'}>
                <Text dimColor={i > 0 && cell === '-'}>{i === 0 ? clip(cell, statNameW - 1) : cell}</Text>
              </Box>
            ))}
          </Box>
        ))}
        <Text dimColor>Hover a column name for its meaning</Text>
      </Box>
    )

    const projectOptions = [
      { value: ALL, label: 'All projects' },
      ...allProjects.map(name => ({ value: name, label: name })),
    ]

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Select } = $.ui.resolve(e)
      const colorOf = (name: string) => SERIES_LIGHT[slotOf(name)] ?? OTHER_LIGHT
      const section = (key: string, title: string, body: RenderChildren) => (
        <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text bold color="#3987e5">{title}</Text>
          {body}
        </Box>
      )

      const header = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {RANGES.map(r => (
              <Button key={`range-${r.id}`} label={r.label} hotkey={r.hotkey} variant={v.range === r.id ? 'primary' : undefined} onPress={set({ range: r.id, offset: 0 })} />
            ))}
          </Box>
          <Box flexDirection="column">
            <Text bold>{mode.title.toUpperCase()}</Text>
            <Text dimColor>{period}</Text>
          </Box>
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="prev" label={`Prev ${mode.unit}`} hotkey="h" onPress={set({ offset: v.offset + 1 })} />
              <Button key="current" label={mode.current} hotkey="t" onPress={set({ offset: 0 })} />
              {v.offset > 0 && <Button key="next" label={`Next ${mode.unit}`} hotkey="l" onPress={set({ offset: Math.max(0, v.offset - 1) })} />}
            </Box>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {METRICS.map(m => (
                <Button key={`metric-${m.id}`} label={m.label} hotkey={m.hotkey} variant={v.metric === m.id ? 'primary' : undefined} onPress={set({ metric: m.id })} />
              ))}
              {allProjects.length > 1 && <Select key="project" options={projectOptions} value={v.project ?? ALL} onSelect={pickProject} />}
            </Box>
          </Box>
        </Box>
      )

      if (ranked.length === 0) {
        return (
          <Box flexDirection="column" gap={1}>
            {header}
            <Text dimColor>No activity recorded for this period.</Text>
          </Box>
        )
      }

      const inner = cols - 4
      const nameW = Math.min(22, Math.max(7, ...order.map(n => n.length)))
      const valW = 12
      const barW = Math.max(6, inner - nameW - valW - 2)
      const topShare = Math.max(1, metricOf(ranked[0]?.[1] ?? emptyProject(), v.metric))

      const cellW = inner - nameW - 1 >= 48 ? 2 : 1
      const maxCell = Math.max(1, ...ranked.flatMap(([, p]) => p.hours))
      const axis = Array.from({ length: 24 }, (_, hr) => (hr % 3 === 0 ? pad2(hr) : '').padEnd(cellW)).join('')
      const dayW = 12
      const stackW = Math.max(6, inner - dayW - 8)
      const maxDay = Math.max(1, ...columns.map(c => c.parts.reduce((s, p) => s + p.value, 0)))

      const summary = (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {kpis.map(k => (
              <Box key={`kpi-${k.label}`} flexDirection="row">
                <Text bold>{k.value}</Text>
                <Text dimColor> {k.label}</Text>
              </Box>
            ))}
          </Box>
          {rhythm !== '' && <Text dimColor>{rhythm}</Text>}
        </Box>
      )

      const share = ranked.map(([name, p]) => {
        const value = metricOf(p, v.metric)
        return (
          <Box key={`share-${name}`} flexDirection="row">
            <Text>{clip(name, nameW).padEnd(nameW)} </Text>
            <Text color={colorOf(name)}>{'■'.repeat(value > 0 ? Math.max(1, Math.round((value / topShare) * barW)) : 0).padEnd(barW)}</Text>
            <Text>{fmtMetric(value, v.metric).padStart(valW - 5)}</Text>
            <Text dimColor>{`${pctOf(value, grand)}%`.padStart(5)}</Text>
          </Box>
        )
      })

      const heatmap = [
        <Text key="axis" dimColor>{' '.repeat(nameW + 1) + axis}</Text>,
        ...ranked.map(([name, p]) => (
          <Box key={`hours-${name}`} flexDirection="row">
            <Text>{clip(name, nameW).padEnd(nameW)} </Text>
            {p.hours.map((ms, hr) => {
              const level = ms > 0 ? Math.min(3, Math.floor((ms / maxCell) * 3.999)) : -1
              return (
                <Text key={`cell-${name}-${hr}`} color={level >= 0 ? HEAT[level] : undefined} dimColor={level < 0}>
                  {(level >= 0 ? (SHADES[level] ?? ' ') : '·').repeat(cellW)}
                </Text>
              )
            })}
          </Box>
        )),
      ]

      const dailyBars = columns.map((c, i) => {
        const sum = c.parts.reduce((s, p) => s + p.value, 0)
        return (
          <Box key={`day-${days[i]}`} flexDirection="row">
            <Text dimColor={sum === 0}>{c.label.padEnd(dayW)}</Text>
            {order.map(name => {
              const n = c.parts.find(p => p.name === name)?.value ?? 0
              return (
                <Text key={`seg-${days[i]}-${name}`} color={colorOf(name)}>
                  {'█'.repeat(n > 0 ? Math.max(1, Math.round((n / maxDay) * stackW)) : 0)}
                </Text>
              )
            })}
            <Text dimColor> {sum > 0 ? fmtMetric(sum, v.metric) : ''}</Text>
          </Box>
        )
      })

      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {section('summary', 'Summary', summary)}
          {section('share', shareTitle, share)}
          {byHour ? section('hours', columnsTitle, heatmap) : section('days', columnsTitle, dailyBars)}
          {section('stats', 'Stats by project', statsTable(Box, Text))}
        </Box>
      )
    }

    const els = $.ui.resolve(e)
    const { Box, Text, Button, Svg } = els
    const Select = 'Select' in els ? els.Select : undefined
    const cls = (name: string) => (slotOf(name) >= 0 ? `s${slotOf(name)}` : 'so')
    const w = Math.max(260, Math.min(740, (cols - 4) * 8))
    const section = (key: string, title: string, body: RenderChildren) => (
      <Box key={key} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1} paddingY={1}>
        <Text bold>{title}</Text>
        {body}
      </Box>
    )

    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {RANGES.map(r => (
            <Button key={`range-${r.id}`} label={r.label} hotkey={r.hotkey} variant={v.range === r.id ? 'primary' : 'secondary'} onPress={set({ range: r.id, offset: 0 })} />
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>{mode.title}</Text>
          <Text dimColor>{period}</Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Button key="prev" label={`Prev ${mode.unit}`} hotkey="h" variant="secondary" onPress={set({ offset: v.offset + 1 })} />
          <Button key="current" label={mode.current} hotkey="t" variant="secondary" onPress={set({ offset: 0 })} />
          {v.offset > 0 && <Button key="next" label={`Next ${mode.unit}`} hotkey="l" variant="secondary" onPress={set({ offset: Math.max(0, v.offset - 1) })} />}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {METRICS.map(m => (
            <Button key={`metric-${m.id}`} label={m.label} hotkey={m.hotkey} variant={v.metric === m.id ? 'primary' : 'secondary'} onPress={set({ metric: m.id })} />
          ))}
          {Select && allProjects.length > 1 && <Select key="project" options={projectOptions} value={v.project ?? ALL} onSelect={pickProject} />}
        </Box>
      </Box>
    )

    if (ranked.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor>No activity recorded for this period.</Text>
        </Box>
      )
    }

    const shareRows = ranked.map(([name, p]) => {
      const value = metricOf(p, v.metric)
      return { name, value, pct: pctOf(value, grand) }
    })
    const labelEvery = byHour ? 3 : span === 7 ? 1 : 5

    const summary = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {kpis.map(k => (
            <Box key={`kpi-${k.label}`} flexDirection="column" minWidth={11}>
              <Text bold>{k.value}</Text>
              <Text dimColor>{k.label}</Text>
            </Box>
          ))}
        </Box>
        {rhythm !== '' && <Text dimColor>{rhythm}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {section('summary', 'Summary', summary)}
        {section(
          'share',
          shareTitle,
          <Svg
            source={shareSvg(shareRows, w, cls, v.metric)}
            alt={shareRows.map(r => `${r.name} ${fmtMetric(r.value, v.metric)} (${r.pct}%)`).join(', ')}
            isInteractive
          />,
        )}
        {section(
          byHour ? 'hours' : 'days',
          columnsTitle,
          <Svg
            source={columnsSvg(columns, order, w, cls, columnsFmt, labelEvery, byHour || v.metric === 'time')}
            alt={columns.map(c => `${c.label} ${columnsFmt(c.parts.reduce((s, p) => s + p.value, 0))}`).join(', ')}
            isInteractive
          />,
        )}
        {section('stats', 'Stats by project', statsTable(Box, Text))}
      </Box>
    )
  })
}
