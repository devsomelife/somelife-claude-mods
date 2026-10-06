import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

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
const COLORS = ['#4e9af1', '#e8a33d', '#5cc28b', '#d96fb4', '#9a7cf0', '#e5645e', '#4cc2c9', '#b8b24a']
const SHADES = [' ', '░', '▒', '▓', '█']
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

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
      name: 'workload',
      description: 'Show the load across your projects in a pane',
    })
    await prune($, retentionDays)
    return next(e)
  })

  on('command.run', { command: 'workload' }, async $ => {
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
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, rev)
    const v = await read($, view)
    const now = await $.clock.now()
    const span = SPANS[v.range]
    const anchor = now - v.offset * span * 24 * HOUR
    const days = Array.from({ length: span }, (_, i) => dayKey(anchor - (span - 1 - i) * 24 * HOUR))
    const logs = await Promise.all(days.map(d => loadDay($, d)))
    const cols = Math.max(40, e.props.bodyColumns)

    // Every project seen in the period keeps one color, even when filtered out
    const allProjects = [...new Set(logs.flatMap(l => Object.keys(l)))].sort()
    const colorOf = (name: string) => COLORS[allProjects.indexOf(name) % COLORS.length] ?? COLORS[0]
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

    const set = (patch: Partial<WorkloadView>) => () => void update($, view, cur => ({ ...cur, ...patch }))
    const period =
      span === 1 ? `${new Date(anchor).toDateString()}` : `${days[0]} to ${days[days.length - 1]}`

    const nameW = Math.min(22, Math.max(7, ...ranked.map(([n]) => n.length)))
    const valW = 14
    const barW = Math.max(6, cols - nameW - valW - 2)

    const bar = (value: number, max: number) => '█'.repeat(max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / max) * barW)) : 0)

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button label="Prev" hotkey="h" onPress={set({ offset: v.offset + 1 })} />
          <Button label="Today" hotkey="t" onPress={set({ offset: 0 })} />
          <Button label="Next" hotkey="l" onPress={set({ offset: Math.max(0, v.offset - 1) })} />
          {RANGES.map(r => (
            <Button
              key={`range-${r.id}`}
              label={r.label}
              hotkey={r.hotkey}
              variant={v.range === r.id ? 'primary' : undefined}
              onPress={set({ range: r.id, offset: 0 })}
            />
          ))}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {METRICS.map(m => (
            <Button
              key={`metric-${m.id}`}
              label={m.label}
              hotkey={m.hotkey}
              variant={v.metric === m.id ? 'primary' : undefined}
              onPress={set({ metric: m.id })}
            />
          ))}
          {v.project !== null && <Button key="all" label={`All projects (${v.project})`} hotkey="a" onPress={set({ project: null })} />}
        </Box>
        <Text bold>{period}</Text>
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

    const activeHours = all.hours.map((ms, h) => (ms > 0 ? h : -1)).filter(h => h >= 0)
    const peak = all.hours.reduce((best, ms, h) => (ms > (all.hours[best] ?? 0) ? h : best), 0)
    const summary = [
      `Active ${fmtDuration(all.activeMs)}`,
      `${fmtCount(all.turns)} turns`,
      `${fmtCount(all.tokens)} tokens`,
      `${fmtCount(all.tools)} tools`,
      `${all.sessions.length} sessions`,
      `${ranked.length} projects`,
    ].join(' | ')
    const rhythm =
      activeHours.length > 0
        ? `First ${hourLabel(activeHours[0] ?? 0)} | last ${hourLabel(activeHours[activeHours.length - 1] ?? 0)} | peak ${hourLabel(peak)}`
        : ''

    const share = (
      <Box flexDirection="column">
        <Text bold>Share by project</Text>
        {ranked.map(([name, p]) => {
          const value = metricOf(p, v.metric)
          const pct = grand > 0 ? Math.round((value / grand) * 100) : 0
          return (
            <Box key={`share-${name}`} flexDirection="row">
              <Button plain dimColor={v.project !== null} label={name.slice(0, nameW).padEnd(nameW)} onPress={set({ project: v.project === name ? null : name })} />
              <Text> </Text>
              <Text color={colorOf(name)}>{bar(value, metricOf(ranked[0]![1], v.metric)).padEnd(barW)}</Text>
              <Text> {`${fmtMetric(value, v.metric)} ${pct}%`.padStart(valW - 1)}</Text>
            </Box>
          )
        })}
      </Box>
    )

    // Day view: one row per project, one cell per hour, shaded by active time
    const cellW = cols - nameW - 1 >= 48 ? 2 : 1
    const maxCell = Math.max(1, ...ranked.flatMap(([, p]) => p.hours))
    const axis = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? pad2(h) : '').padEnd(cellW)).join('')
    const timeline = (
      <Box flexDirection="column">
        <Text bold>Active time by hour</Text>
        <Text dimColor>{' '.repeat(nameW + 1) + axis}</Text>
        {ranked.map(([name, p]) => (
          <Box key={`hours-${name}`} flexDirection="row">
            <Text>{name.slice(0, nameW).padEnd(nameW)} </Text>
            <Text color={colorOf(name)}>
              {p.hours
                .map(ms => (SHADES[ms > 0 ? Math.max(1, Math.round((ms / maxCell) * 4)) : 0] ?? ' ').repeat(cellW))
                .join('')}
            </Text>
          </Box>
        ))}
        <Box flexDirection="row">
          <Text dimColor>{'all'.padEnd(nameW)} </Text>
          <Text>
            {all.hours
              .map(ms => {
                const top = Math.max(1, ...all.hours)
                return ms > 0 ? (SPARKS[Math.min(7, Math.floor((ms / top) * 7.999))] ?? ' ').repeat(cellW) : ' '.repeat(cellW)
              })
              .join('')}
          </Text>
        </Box>
      </Box>
    )

    // Week and month views: one stacked bar per day, a segment per project
    const dayTotals = logs.map(log =>
      Object.entries(log)
        .filter(([name]) => keep(name))
        .map(([name, p]) => [name, metricOf({ ...emptyProject(), ...p }, v.metric)] as const),
    )
    const maxDay = Math.max(1, ...dayTotals.map(d => d.reduce((s, [, n]) => s + n, 0)))
    const dayW = 10
    const stackW = Math.max(6, cols - dayW - 10)
    const daily = (
      <Box flexDirection="column">
        <Text bold>Load by day</Text>
        {days.map((day, i) => {
          const parts = dayTotals[i] ?? []
          const sum = parts.reduce((s, [, n]) => s + n, 0)
          const label = `${new Date(`${day}T12:00:00`).toDateString().slice(0, 3)} ${day.slice(5)}`
          return (
            <Box key={`day-${day}`} flexDirection="row">
              <Text dimColor={sum === 0}>{label.padEnd(dayW)}</Text>
              {parts.map(([name, n]) => (
                <Text key={`seg-${day}-${name}`} color={colorOf(name)}>
                  {'█'.repeat(n > 0 ? Math.max(1, Math.round((n / maxDay) * stackW)) : 0)}
                </Text>
              ))}
              <Text dimColor> {sum > 0 ? fmtMetric(sum, v.metric) : '-'}</Text>
            </Box>
          )
        })}
      </Box>
    )

    const statW = [nameW, 8, 6, 6, 8, 6, 5, 5]
    const row = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(statW[i] ?? 6) : c.padStart(statW[i] ?? 6))).join(' ')
    const stats = (
      <Box flexDirection="column">
        <Text bold>Stats by project</Text>
        <Text dimColor>{row(['Project', 'Time', 'Share', 'Turns', 'Tokens', 'Tools', 'Sess', 'Peak'])}</Text>
        {ranked.map(([name, p]) => {
          const pk = p.hours.reduce((best, ms, h) => (ms > (p.hours[best] ?? 0) ? h : best), 0)
          return (
            <Text key={`stat-${name}`} color={colorOf(name)}>
              {row([
                name.slice(0, nameW),
                fmtDuration(p.activeMs),
                `${all.activeMs > 0 ? Math.round((p.activeMs / all.activeMs) * 100) : 0}%`,
                fmtCount(p.turns),
                fmtCount(p.tokens),
                fmtCount(p.tools),
                String(p.sessions.length),
                p.activeMs > 0 ? hourLabel(pk) : '-',
              ])}
            </Text>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="column">
          <Text>{summary}</Text>
          {rhythm !== '' && <Text dimColor>{rhythm}</Text>}
        </Box>
        {share}
        {span === 1 ? timeline : daily}
        {span > 1 && timeline}
        {stats}
      </Box>
    )
  })
}
