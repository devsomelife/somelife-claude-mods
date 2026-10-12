import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionAppendInput, SessionAppendMessage, Timer } from 'claude-code'

import type { LeaksFilter, LeaksTab, LeaksView } from '../types'
import { KINDS, PLACEHOLDER, redact, spansOf } from './detect'
import type { Category, Kind, Match, Span } from './detect'

// How the value reached the model
export type Via = 'prompt' | 'tool' | 'model' | 'context' | 'side-call'

// What the mod did with the value: let it through, replaced it, withheld it
export type Action = 'seen' | 'redacted' | 'blocked'

export type Mode = 'notify' | 'redact' | 'block'

export type Hit = { at: number; via: Via; source: string; session: string; action?: Action }

// One distinct value seen in a project, stored under `project:<name>`
export type Finding = {
  id: string
  kind: Kind
  category: Category
  value: string
  count: number
  firstAt: number
  lastAt: number
  hits: Hit[]
}

export type ProjectLog = Record<string, Finding>

const PANE = 'leaks'
const DAY = 86_400_000
const PROJECT_PREFIX = 'project:'
const HITS_PER_FINDING = 20
const FINDINGS_PER_PROJECT = 300
const TIMELINE_ROWS = 100
// Wait before writing findings, so the rows of one burst share one write
const FLUSH_MS = 250

const VIA_LABELS: Record<Via, string> = {
  prompt: 'Sent by you',
  tool: 'Read by a tool',
  model: 'Written by the model',
  context: 'Added as context',
  'side-call': 'Side model call',
}
const ACTION_LABELS: Record<Action, string> = { seen: 'seen', redacted: 'redacted', blocked: 'blocked' }
// Tools that write: in redact mode they may not write placeholders back over real values
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
const COLORS: Record<Category, string> = { private: '#3987e5', medical: '#e87ba4' }
const TABS: { id: LeaksTab; label: string; hotkey: string }[] = [
  { id: 'findings', label: 'Findings', hotkey: 'f' },
  { id: 'timeline', label: 'Timeline', hotkey: 't' },
]
const FILTERS: { id: LeaksFilter; label: string; hotkey: string }[] = [
  { id: 'all', label: 'All', hotkey: 'a' },
  { id: 'private', label: 'Private', hotkey: 'p' },
  { id: 'medical', label: 'Medical', hotkey: 'm' },
]

const view = atom({ plugin: 'leaks', key: 'view' } as const, {
  tab: 'findings',
  filter: 'all',
  project: null,
  confirmClear: false,
} as LeaksView)
const rev = atom({ plugin: 'leaks', key: 'rev' } as const, 0)

const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}.` : s)

const pad2 = (n: number) => String(n).padStart(2, '0')

export const fmtWhen = (t: number, now: number) => {
  const d = new Date(t)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? `today ${hm}` : `${d.toDateString().slice(4, 10)} ${hm}`
}

// Short description of a tool call: the tool and what it touched
export const describeTool = (tool: string, input: Record<string, unknown>, root: string) => {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  const rel = path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const target = rel ?? str('command') ?? str('url') ?? str('query') ?? str('pattern') ?? str('description')
  return target ? `${tool} ${clip(oneLine(target), 80)}` : tool
}

const stringsOf = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out)
  return out
}

const resultText = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('\n')
      : ''



type Piece = { text: string; via: Via; source: string }

type Found = { m: Match; p: Piece; action: Action }

type Settings = { mode: Mode; notify: string; storeRaw: boolean; ignore: string[] }

// Scans one text; in redact or block mode also answers what replaces it
export const guard = (s: Settings, p: Piece, canChange: boolean) => {
  const spans: Span[] = s.ignore.some(i => p.source.toLowerCase().includes(i)) ? [] : spansOf(p.text, s.ignore)
  const action: Action = spans.length === 0 || !canChange || s.mode === 'notify' ? 'seen' : s.mode === 'redact' ? 'redacted' : 'blocked'
  const seen = new Set<string>()
  const found: Found[] = []
  for (const sp of spans) {
    if (seen.has(sp.fingerprint)) continue
    seen.add(sp.fingerprint)
    found.push({ m: sp, p, action })
  }
  const text = action === 'redacted' ? redact(p.text, spans) : action === 'blocked' ? withheld(found) : p.text
  return { text, found, spans }
}

const kindsOf = (found: readonly Found[]) => [...new Set(found.map(f => KINDS[f.m.kind].label.toLowerCase()))].join(', ')

const withheld = (found: readonly Found[]) =>
  `[Withheld by the leaks mod: this content contains ${kindsOf(found)}. Ask the user if you need it.]`

// One row as the model will read it: scanned, and rewritten in redact or block mode
export const guardRow = (s: Settings, e: SessionAppendInput) => {
  const message = e.message
  const sub = e.agentId !== undefined ? ' (subagent)' : ''
  const rowVia: Via = e.door === 'prompt' ? 'prompt' : e.door === 'response' ? 'model' : 'context'
  const rowSource =
    e.door === 'prompt'
      ? 'prompt'
      : e.door === 'response'
        ? 'reply'
        : e.door === 'attachment'
          ? (message.name ?? 'attachment').replace(/_/g, ' ')
          : e.door.replace(/-/g, ' ')
  // The model's own output came from the server: it is recorded, never rewritten
  const canChange = e.door !== 'response'
  const found: Found[] = []
  let changed = false

  const content = message.content.map(b => {
    if (b.type === 'text' && typeof b.text === 'string') {
      const g = guard(s, { text: b.text, via: rowVia, source: rowSource + sub }, canChange)
      found.push(...g.found)
      if (g.text === b.text) return b
      changed = true
      return { ...b, text: g.text }
    }
    if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'tool'
      const input = (b.input ?? {}) as Record<string, unknown>
      found.push(...guard(s, { text: stringsOf(input).join('\n'), via: 'model', source: describeTool(name, input, root) + sub }, false).found)
      return b
    }
    if (b.type === 'tool_result') {
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
      const source = (toolLabels.get(id) ?? (e.origin.kind === 'tool' ? e.origin.tool : 'tool')) + sub
      toolLabels.delete(id)
      const piece = { text: resultText(b.content), via: 'tool' as const, source }
      const g = guard(s, piece, canChange)
      found.push(...g.found)
      if (g.text === piece.text) return b
      changed = true
      if (s.mode === 'block') return { ...b, content: g.text }
      // Redact each text part, keeping images and documents where they stand
      const parts = Array.isArray(b.content)
        ? b.content.map(c =>
            c && typeof c === 'object' && 'text' in c && typeof c.text === 'string'
              ? { ...c, text: guard(s, { ...piece, text: c.text }, true).text }
              : c,
          )
        : g.text
      return { ...b, content: parts }
    }
    return b
  })
  return { message: changed ? { ...message, content } : message, found }
}

// Session-scoped facts, rebuilt on reload
const toolLabels = new Map<string, string>()
const seenThisSession = new Set<string>()
let root = ''
let project = ''
let session = ''
// Serialises read-modify-write cycles on the store within this session
let queue: Promise<unknown> = Promise.resolve()
// Findings waiting to be written, so the conversation never waits on the store
let pending: Found[] = []
let flushTimer: Timer | null = null

const projectOf = async ($: EngineInterface) => {
  const repo = await $.session.repo().catch(() => null)
  return basename(repo?.root ?? (await $.session.root()))
}

const loadProject = async ($: EngineInterface, name: string) =>
  ((await $.store.get(PROJECT_PREFIX + name)) ?? {}) as ProjectLog

async function edit($: EngineInterface, name: string, fn: (log: ProjectLog) => ProjectLog) {
  const run = async () => {
    const log = fn(await loadProject($, name))
    if (Object.keys(log).length === 0) await $.store.delete(PROJECT_PREFIX + name)
    else await $.store.set(PROJECT_PREFIX + name, log)
  }
  queue = queue.then(run, run)
  return queue
}

const capFindings = (log: ProjectLog) => {
  const all = Object.values(log)
  if (all.length <= FINDINGS_PER_PROJECT) return log
  const keep = all.sort((a, b) => b.lastAt - a.lastAt).slice(0, FINDINGS_PER_PROJECT)
  return Object.fromEntries(keep.map(f => [f.id, f]))
}

const summarize = (ms: Match[]) => {
  const label = (m: Match) => `${KINDS[m.kind].label.toLowerCase()} ${m.masked}`
  const head = ms.slice(0, 2).map(label).join(', ')
  return ms.length > 2 ? `${head}, +${ms.length - 2} more` : head
}

async function announce($: EngineInterface, s: Settings, fresh: Found[]) {
  const first = fresh[0]
  if (!first || s.notify === 'off') return
  const text = `${summarize(fresh.map(f => f.m))}. ${VIA_LABELS[first.p.via]}: ${first.p.source} (${project})`
  const title = `Sensitive data ${ACTION_LABELS[first.action]}`
  if (s.notify === 'toast' || s.notify === 'both') $.ui.toast(`${title}: ${text}`, { timeoutMs: 8000 })
  if (s.notify === 'system' || s.notify === 'both') await $.ui.notify(text, { title }).catch(() => undefined)
  $.ui.status(`${seenThisSession.size} sensitive item${seenThisSession.size === 1 ? '' : 's'} this session, /some-leaks`)
}

// Queues findings; storing and notifying happen just after, off the conversation's path
function collect($: EngineInterface, s: Settings, found: readonly Found[]) {
  pending.push(...found)
  if (pending.length === 0 || flushTimer !== null) return
  flushTimer = $.clock.after(FLUSH_MS, () => void flush($, s).catch(() => undefined))
}

async function flush($: EngineInterface, s: Settings) {
  flushTimer?.cancel()
  flushTimer = null
  const found = pending
  pending = []
  if (found.length === 0) return

  const now = await $.clock.now()
  if (project === '') project = await projectOf($)
  if (session === '') session = await $.session.id()

  const fresh: Found[] = []
  for (const f of found) {
    if (seenThisSession.has(f.m.fingerprint)) continue
    seenThisSession.add(f.m.fingerprint)
    fresh.push(f)
  }

  await edit($, project, log => {
    for (const { m, p, action } of found) {
      const prev = log[m.fingerprint]
      const hit: Hit = { at: now, via: p.via, source: p.source, session, action }
      log[m.fingerprint] = {
        id: m.fingerprint,
        kind: m.kind,
        category: m.category,
        value: s.storeRaw ? m.value : m.masked,
        count: (prev?.count ?? 0) + 1,
        firstAt: prev?.firstAt ?? now,
        lastAt: now,
        hits: [hit, ...(prev?.hits ?? [])].slice(0, HITS_PER_FINDING),
      }
    }
    return capFindings(log)
  })
  await update($, rev, n => (n ?? 0) + 1)
  await announce($, s, fresh)
}

async function prune($: EngineInterface, retentionDays: number) {
  const cutoff = (await $.clock.now()) - retentionDays * DAY
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PROJECT_PREFIX)) continue
    await edit($, key.slice(PROJECT_PREFIX.length), log => {
      const out: ProjectLog = {}
      for (const f of Object.values(log)) {
        const hits = f.hits.filter(hit => hit.at >= cutoff)
        if (hits.length > 0) out[f.id] = { ...f, hits }
      }
      return out
    })
  }
}

const MODES: readonly Mode[] = ['notify', 'redact', 'block']

export const register: Register = (on, options) => {
  const retentionDays = typeof options.retentionDays === 'number' ? options.retentionDays : 90
  const settings: Settings = {
    mode: MODES.find(m => m === options.mode) ?? 'redact',
    notify: typeof options.notify === 'string' ? options.notify : 'toast',
    storeRaw: options.storeRawValues === true,
    ignore: (typeof options.ignore === 'string' ? options.ignore : '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s !== ''),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'some-leaks',
      description: 'List the private and medical data seen by the model, per project',
    })
    root = await $.session.root()
    await prune($, retentionDays)
    return next(e)
  })

  // Writes what is still waiting before the session closes
  on('session.end', async ($, e, next) => {
    await flush($, settings).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'some-leaks' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Leaks' })
    return { text: 'Leaks pane opened.' }
  })

  // Remembers what each tool call touched, to name the source of its result;
  // in redact mode, refuses to write placeholders back over the real values
  on('tool.call', ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    toolLabels.set(e.tool_use_id, describeTool(String(e.tool), input, root))
    if (settings.mode === 'redact' && WRITERS.has(String(e.tool)) && PLACEHOLDER.test(stringsOf(input).join('\n'))) {
      return {
        deny:
          'This input contains [redacted:...] placeholders the leaks mod put in place of private or medical data. ' +
          'Writing it would replace the real values. Ask the user to make this change.',
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // In block mode, a prompt holding sensitive data is not sent and goes back to the prompt box
  on('prompt.submit', async ($, e, next) => {
    if (settings.mode !== 'block') return next(e)
    const g = guard(settings, { text: e.text, via: 'prompt', source: 'prompt' }, true)
    if (g.found.length === 0) return next(e)
    collect($, settings, g.found)
    if (e.origin.kind === 'composer') {
      const decorations = g.spans.map(sp => ({ start: sp.start, end: sp.end, underline: true, color: COLORS[sp.category] }))
      await $.prompt.fill({ text: e.text, decorations }).catch(() => undefined)
    }
    return { drop: `Not sent: the prompt contains ${kindsOf(g.found)} (leaks mod, block mode). Remove the underlined parts, or change the mode.` }
  }).catch(($, e, next) => next(e))

  // Every row the conversation keeps, as the model will read it
  on('session.append', async ($, e, next) => {
    if (e.door === 'notice' || e.door === 'compaction' || e.message.role === undefined) return next(e)
    let guarded: ReturnType<typeof guardRow> | null = null
    try {
      guarded = guardRow(settings, e)
    } catch {
      // A failed scan never affects the row
    }
    const stored = await next(guarded && guarded.message !== e.message ? { ...e, message: guarded.message } : e)
    if (guarded) collect($, settings, guarded.found)
    return stored
  }).catch(($, e, next) => next(e))

  on('model.complete', async ($, e, next) => {
    const p = guard(settings, { text: e.prompt, via: 'side-call', source: `complete ${e.model}` }, true)
    const sys = e.system === undefined ? null : guard(settings, { text: e.system, via: 'side-call', source: `complete ${e.model}` }, true)
    const found = [...p.found, ...(sys?.found ?? [])]
    collect($, settings, found)
    if (found.length === 0 || settings.mode === 'notify') return next(e)
    if (settings.mode === 'block') return { deny: `Not sent: the request contains ${kindsOf(found)} (leaks mod, block mode)` }
    return next({ ...e, prompt: p.text, ...(sys ? { system: sys.text } : {}) })
  }).catch(($, e, next) => next(e))

  on('model.fork', async ($, e, next) => {
    const p = guard(settings, { text: e.prompt, via: 'side-call', source: 'fork' }, true)
    collect($, settings, p.found)
    if (p.found.length === 0 || settings.mode === 'notify') return next(e)
    if (settings.mode === 'block') return { deny: `Not sent: the request contains ${kindsOf(p.found)} (leaks mod, block mode)` }
    return next({ ...e, prompt: p.text })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Select = 'Select' in els ? els.Select : undefined
    await read($, rev)
    const v = await read($, view)
    const now = await $.clock.now()
    const current = project !== '' ? project : await projectOf($)
    const projects = (await $.store.keys())
      .filter(k => k.startsWith(PROJECT_PREFIX))
      .map(k => k.slice(PROJECT_PREFIX.length))
    if (!projects.includes(current)) projects.push(current)
    projects.sort()
    const shown = v.project ?? current
    const log = await loadProject($, shown)
    const findings = Object.values(log)
      .filter(f => v.filter === 'all' || f.category === v.filter)
      .sort((a, b) => b.lastAt - a.lastAt)
    const cols = Math.max(32, e.props.bodyColumns)

    const set = (patch: Partial<LeaksView>) => () => void update($, view, cur => ({ ...cur, confirmClear: false, ...patch }))
    const pickProject = (value: string) =>
      void update($, view, cur => ({ ...cur, confirmClear: false, project: value === current ? null : value }))
    const clear = async () => {
      await edit($, shown, () => ({}))
      for (const f of Object.values(log)) seenThisSession.delete(f.id)
      await update($, view, cur => ({ ...cur, confirmClear: false }))
      await update($, rev, n => (n ?? 0) + 1)
    }

    const all = Object.values(log)
    const counts = {
      private: all.filter(f => f.category === 'private').length,
      medical: all.filter(f => f.category === 'medical').length,
      hits: all.reduce((s, f) => s + f.count, 0),
    }
    const last = all.reduce((t, f) => Math.max(t, f.lastAt), 0)

    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {TABS.map(t => (
            <Button key={`tab-${t.id}`} label={t.label} hotkey={t.hotkey} variant={v.tab === t.id ? 'primary' : 'secondary'} onPress={set({ tab: t.id })} />
          ))}
          {FILTERS.map(f => (
            <Button key={`filter-${f.id}`} label={f.label} hotkey={f.hotkey} variant={v.filter === f.id ? 'primary' : 'secondary'} onPress={set({ filter: f.id })} />
          ))}
          {Select && projects.length > 1 && (
            <Select key="project" options={projects.map(p => ({ value: p, label: p === current ? `${p} (current)` : p }))} value={shown} onSelect={pickProject} />
          )}
        </Box>
        <Box key="summary" flexDirection="column">
          <Text bold>{shown}</Text>
          <Text dimColor>{`Mode: ${settings.mode}`}</Text>
          <Text dimColor>
            {all.length === 0
              ? 'Nothing seen yet'
              : `${counts.private} private, ${counts.medical} medical, ${counts.hits} occurrences, last ${fmtWhen(last, now)}`}
          </Text>
        </Box>
      </Box>
    )

    if (findings.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor>No {v.filter === 'all' ? 'sensitive' : v.filter} data seen by the model in this project.</Text>
        </Box>
      )
    }

    const chip = (f: Finding) => (
      <Text color={COLORS[f.category]} bold>
        {KINDS[f.kind].label}
      </Text>
    )
    const origin = (hit: Hit) => clip(`${VIA_LABELS[hit.via]}: ${hit.source}, ${ACTION_LABELS[hit.action ?? 'seen']}`, cols - 4)

    let body: RenderChildren
    if (v.tab === 'findings') {
      body = findings.map(f => {
        const latest = f.hits[0]
        return (
          <Box key={`finding-${f.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {chip(f)}
              <Text>{clip(f.value, Math.max(12, cols - 30))}</Text>
              <Text dimColor>x{f.count}</Text>
            </Box>
            <Text dimColor>{`  last ${fmtWhen(f.lastAt, now)}, first ${fmtWhen(f.firstAt, now)}`}</Text>
            {latest && <Text dimColor>{`  ${origin(latest)}`}</Text>}
          </Box>
        )
      })
    } else {
      const hits = findings
        .flatMap(f => f.hits.map((hit, i) => ({ f, hit, i })))
        .sort((a, b) => b.hit.at - a.hit.at)
        .slice(0, TIMELINE_ROWS)
      body = hits.map(({ f, hit, i }) => (
        <Box key={`hit-${f.id}-${i}`} flexDirection="column">
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text dimColor>{fmtWhen(hit.at, now)}</Text>
            {chip(f)}
            <Text>{clip(f.value, Math.max(12, cols - 40))}</Text>
          </Box>
          <Text dimColor>{`  ${origin(hit)}`}</Text>
        </Box>
      ))
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box key="list" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1}>
          {body}
        </Box>
        <Box flexDirection="row" gap={1}>
          {v.confirmClear && <Button key="clear-confirm" label={`Delete ${shown} history`} variant="primary" onPress={clear} />}
          {v.confirmClear && <Button key="clear-cancel" label="Cancel" onPress={set({})} />}
          {!v.confirmClear && <Button key="clear" label="Clear project" onPress={set({ confirmClear: true })} />}
        </Box>
      </Box>
    )
  })
}
