import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, TurnCompleteInput } from 'claude-code'

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

const PANE = 'workload'
const HOUR = 3_600_000
const DAY_PREFIX = 'day:'
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

// Card colors, readable on light and dark themes; past the top projects, "Other" is gray
const PALETTE = ['#3987e5', '#e8743b', '#1baf7a', '#eda100', '#e87ba4', '#9085e9']
const OTHER = '#8a8984'
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const CARD_W = 30

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

const plural = (n: number, word: string) => `${fmtCount(n)} ${word}${n === 1 ? '' : 's'}`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}.` : s)

// Folds `values` into at most `width` buckets by summing neighbours
export const resample = (values: number[], width: number) => {
  if (values.length <= width) return values
  return Array.from({ length: width }, (_, i) => {
    const from = Math.floor((i * values.length) / width)
    const to = Math.floor(((i + 1) * values.length) / width)
    return values.slice(from, to).reduce((s, n) => s + n, 0)
  })
}

// One bar glyph per bucket, stretched to `width`, scaled to `max`
export const sparkline = (buckets: number[], width: number, max: number) => {
  const per = Math.max(1, Math.floor(width / Math.max(1, buckets.length)))
  return buckets
    .map(n => (n > 0 ? (SPARKS[Math.min(7, Math.floor((n / Math.max(1, max)) * 7.999))] ?? ' ') : ' ').repeat(per))
    .join('')
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
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Select = 'Select' in els ? els.Select : undefined
    await read($, rev)
    const v = await read($, view)
    const now = await $.clock.now()
    const span = SPANS[v.range]
    const anchor = now - v.offset * span * 24 * HOUR
    const days = Array.from({ length: span }, (_, i) => dayKey(anchor - (span - 1 - i) * 24 * HOUR))
    const logs = await Promise.all(days.map(d => loadDay($, d)))
    const cols = Math.max(32, e.props.bodyColumns)

    const allProjects = [...new Set(logs.flatMap(l => Object.keys(l)))].sort()
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
    const metricLabel = METRICS.find(m => m.id === v.metric)?.label ?? ''

    const projectOptions = [
      { value: ALL, label: 'All projects' },
      ...allProjects.map(name => ({ value: name, label: name })),
    ]

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

    const section = (key: string, title: string, body: RenderChildren) => (
      <Box key={key} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text bold>{title}</Text>
        {body}
      </Box>
    )

    // Day view: active time per hour over the active window; week and 30 days: chosen metric per day
    const byHour = span === 1
    const activeHours = all.hours.map((ms, hr) => (ms > 0 ? hr : -1)).filter(hr => hr >= 0)
    const firstHour = activeHours[0] ?? 0
    const lastHour = activeHours[activeHours.length - 1] ?? 23
    const from = Math.max(0, Math.min(firstHour, lastHour - 5))
    const to = Math.min(23, Math.max(lastHour, from + 5))
    const seriesOf = (names: string[]) =>
      byHour
        ? Array.from({ length: to - from + 1 }, (_, i) =>
            names.reduce((s, name) => s + (totals.get(name)?.hours[from + i] ?? 0), 0),
          )
        : logs.map(log =>
            names.reduce((s, name) => s + metricOf({ ...emptyProject(), ...log[name] }, v.metric), 0),
          )
    const axis = byHour
      ? [hourLabel(from), hourLabel(to)]
      : [`${weekday(days[0] ?? '')} ${(days[0] ?? '').slice(8)}`, `${weekday(days[days.length - 1] ?? '')} ${(days[days.length - 1] ?? '').slice(8)}`]
    const trendTitle = byHour ? 'Working time by hour' : `${metricLabel} by day`

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
        ? `First activity ${hourLabel(firstHour)}, last ${hourLabel(lastHour)}, peak ${hourLabel(peakHour(all.hours))}`
        : ''

    const trendW = Math.max(12, cols - 6)
    const trendBuckets = resample(seriesOf(ranked.map(([n]) => n)), trendW)
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
        <Box key={byHour ? 'trend-hours' : 'trend-days'} flexDirection="column">
          <Text dimColor>{trendTitle}</Text>
          <Text>{sparkline(trendBuckets, trendW, Math.max(...trendBuckets))}</Text>
          <Box flexDirection="row" justifyContent="space-between" width={trendW}>
            <Text dimColor>{axis[0]}</Text>
            <Text dimColor>{axis[1]}</Text>
          </Box>
        </Box>
      </Box>
    )

    // Top projects get a colored card each; the rest fold into one gray "Other" card
    const topN = ranked.length > PALETTE.length + 1 ? PALETTE.length : ranked.length
    const top = ranked.slice(0, topN)
    const rest = ranked.slice(topN)
    const restTotal = emptyProject()
    for (const [, p] of rest) merge(restTotal, p)
    const cards = [
      ...top.map(([name, p], i) => ({ key: name, label: name, color: PALETTE[i] ?? OTHER, p, names: [name] })),
      ...(rest.length > 0
        ? [{ key: 'other', label: `Other (${rest.length})`, color: OTHER, p: restTotal, names: rest.map(([n]) => n) }]
        : []),
    ]
    const perRow = Math.max(1, Math.floor((cols - 4 + 1) / (CARD_W + 1)))
    const cardW = Math.max(20, Math.floor((cols - 4 - (perRow - 1)) / perRow))
    const inner = cardW - 4
    const cardBuckets = cards.map(c => resample(seriesOf(c.names), inner))
    const cardMax = Math.max(...cardBuckets.flat())

    const projects = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {cards.map((c, i) => {
          const value = metricOf(c.p, v.metric)
          return (
            <Box key={`card-${c.key}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={cardW}>
              <Box flexDirection="row">
                <Text color={c.color}>● </Text>
                <Text bold>{clip(c.label, inner - 2)}</Text>
              </Box>
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>{fmtMetric(value, v.metric)}</Text>
                <Text dimColor>{pctOf(value, grand)}%</Text>
              </Box>
              <Text dimColor>{`${plural(c.p.turns, 'turn')}, ${plural(c.p.sessions.length, 'session')}`}</Text>
              <Text color={c.color}>{sparkline(cardBuckets[i] ?? [], inner, cardMax)}</Text>
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor>{axis[0]}</Text>
                <Text dimColor>{axis[1]}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )

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
    const statNameW = Math.min(24, Math.max(8, ...ranked.map(([n]) => n.length)) + 1)
    const stats = (
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

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {section('summary', 'Summary', summary)}
        {section('projects', `${metricLabel} by project`, projects)}
        {section('stats', 'Stats by project', stats)}
      </Box>
    )
  })
}
