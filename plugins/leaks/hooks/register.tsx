import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionAppendInput, SessionAppendMessage, Timer } from 'claude-code'

import type { LeaksFilter, LeaksTab, LeaksView } from '../types'
import { KINDS, PLACEHOLDER, isKind, redact, spansOf } from './detect'
import {
  MODES,
  absolute,
  formatFolderIgnores,
  formatRules,
  isMode,
  matcher,
  parseFolderIgnores,
  parsePatterns,
  parseRules,
  patternsFor,
  ruleFor,
  stricter,
  tilde,
  withIgnore,
  withRule,
} from './rules'
import { sha256 } from './sha256'
import type { Category, Kind, Match, Span } from './detect'
import type { FolderIgnore, Mode, Rule } from './rules'

export type { Mode } from './rules'

// How the value reached the model
export type Via = 'prompt' | 'tool' | 'model' | 'context' | 'side-call'

// What the mod did with the value: let it through, replaced it, withheld it
export type Action = 'seen' | 'redacted' | 'blocked'

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
const MODE_LABELS: Record<Mode, string> = { off: 'Off', notify: 'Notify', redact: 'Redact', block: 'Block' }
// Tools that write: in redact and block modes they may not write placeholders back over real values
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])
const COLORS: Record<Category, string> = { private: '#3987e5', secret: '#e8a33d' }
const TABS: { id: LeaksTab; label: string; hotkey: string }[] = [
  { id: 'findings', label: 'Findings', hotkey: 'f' },
  { id: 'timeline', label: 'Timeline', hotkey: 't' },
  { id: 'rules', label: 'Rules', hotkey: 'r' },
]
const FILTERS: { id: LeaksFilter; label: string; hotkey: string }[] = [
  { id: 'all', label: 'All', hotkey: 'a' },
  { id: 'private', label: 'Private', hotkey: 'p' },
  { id: 'secret', label: 'Secrets', hotkey: 's' },
]

const view = atom({ plugin: 'leaks', key: 'view' } as const, {
  tab: 'findings',
  filter: 'all',
  project: null,
  confirmClear: false,
  notice: null,
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

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// The file a tool call touches, when it names one
const pathOf = (input: Record<string, unknown>) => {
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string' && input[k] !== '') return input[k] as string
  return undefined
}

// Short description of a tool call: the tool and the file it touched, or the host it fetched.
// Commands, queries and full URLs are left out: they can carry tokens or passwords
export const describeTool = (tool: string, input: Record<string, unknown>, root: string) => {
  const path = pathOf(input)
  if (path) {
    const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    return `${tool} ${clip(oneLine(rel), 80)}`
  }
  const host = hostOf(typeof input.url === 'string' ? input.url : '')
  return host ? `${tool} ${host}` : tool
}

const stringsOf = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out)
  return out
}

type Piece = { text: string; via: Via; source: string }

type Found = { m: Match; p: Piece; action: Action }

// `mode` is the default mode and `rules` set other modes per folder;
// `ignore` holds the entries skipped everywhere and `folderIgnores` those skipped per folder
type Settings = {
  mode: Mode
  rules: Rule[]
  rulesText: string
  ignore: string[]
  folderIgnores: FolderIgnore[]
  folderIgnoreText: string
  notify: string
  storeRaw: boolean
  failClosed: boolean
  // The /config values this module loaded with, which a change kept in the store was made over
  base: Record<Field, string>
}

// How one text is scanned: its mode, and whether a value or source is ignored
export type Scan = { mode: Mode; skip: (s: string) => boolean }

// Scans one text; in redact or block mode also answers what replaces it
export const guard = (s: Scan, p: Piece, canChange: boolean) => {
  if (s.mode === 'off') return { text: p.text, found: [] as Found[], spans: [] as Span[] }
  const spans: Span[] = s.skip(p.source) ? [] : spansOf(p.text, s.skip)
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

const SCAN_FAILED = '[Withheld by the leaks mod: this content could not be scanned. Ask the user if you need it.]'

// The row with every text the model would read withheld: what a failed scan sends when failing closed
export const withheldRow = (message: SessionAppendMessage): SessionAppendMessage => ({
  ...message,
  content: message.content.map(b =>
    b.type === 'text' ? { ...b, text: SCAN_FAILED } : b.type === 'tool_result' ? { ...b, content: SCAN_FAILED } : b,
  ),
})

const isTextPart = (c: unknown): c is { text: string } =>
  !!c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string'

const resultIds = (e: SessionAppendInput) =>
  e.message.content.flatMap(b => (b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? [b.tool_use_id] : []))

// One row as the model will read it: scanned, and rewritten in redact or block mode.
// `s` is the session's scan; a tool result takes the scan its call was given
export const guardRow = (s: Scan, e: SessionAppendInput) => {
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
      const call = toolCalls.get(id)
      const ts: Scan = call ? { mode: call.mode, skip: call.skip } : s
      const source = (call?.label ?? (e.origin.kind === 'tool' ? e.origin.tool : 'tool')) + sub
      const piece = (text: string) => ({ text, via: 'tool' as const, source })
      if (!Array.isArray(b.content)) {
        const text = typeof b.content === 'string' ? b.content : ''
        const g = guard(ts, piece(text), canChange)
        found.push(...g.found)
        if (g.text === text) return b
        changed = true
        return { ...b, content: g.text }
      }
      // Each text part is scanned once and redacted in place; images and documents stay where they stand
      const partFound: Found[] = []
      const parts = b.content.map(c => {
        if (!isTextPart(c)) return c
        const g = guard(ts, piece(c.text), canChange)
        partFound.push(...g.found)
        return g.text === c.text ? c : { ...c, text: g.text }
      })
      found.push(...partFound)
      if (partFound.length === 0 || !canChange || ts.mode === 'notify') return b
      changed = true
      return { ...b, content: ts.mode === 'block' ? withheld(partFound) : parts }
    }
    return b
  })
  return { message: changed ? { ...message, content } : message, found }
}

// Session-scoped facts, rebuilt on reload
// What each tool call touched and how its result is scanned
const toolCalls = new Map<string, Scan & { label: string }>()
// Full values of this session's findings by stored id, so the pane can ignore them; never written anywhere
const rawThisSession = new Map<string, string>()
// Ignore matchers by the folders they apply to, rebuilt when a setting changes
const skipCache = new Map<string, (s: string) => boolean>()
const seenThisSession = new Set<string>()
let root = ''
let home = ''
let project = ''
let session = ''
// Serialises read-modify-write cycles on the store within this session
let queue: Promise<unknown> = Promise.resolve()
// Findings waiting to be written, so the conversation never waits on the store
let pending: Found[] = []
let flushTimer: Timer | null = null
// Stored ids by kind and normalized value, so each value is hashed once per load
const ids = new Map<string, string>()
let secret: Promise<string> | null = null

const SECRET = 'secret:fingerprint'

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

// This install's random secret, made on first use, so stored ids cannot be matched against guessed values
// without it, nor compared across machines
const secretOf = ($: EngineInterface) =>
  (secret ??= (async () => {
    const known = await $.store.get(SECRET)
    if (typeof known === 'string' && known.length === 64) return known
    const made = hex(crypto.getRandomValues(new Uint8Array(32)))
    await $.store.set(SECRET, made)
    return made
  })())

// The stored id of a value: SHA-256 of the secret, its kind and normalized form, cut to 96 bits
export const idFor = (secretHex: string, key: string) => {
  const known = ids.get(key)
  if (known) return known
  const id = hex(sha256(new TextEncoder().encode(`${secretHex}\n${key}`)).slice(0, 12))
  ids.set(key, id)
  return id
}

// The folder a project rule applies to: the git repository's root, or the session's outside git
const projectRootOf = async ($: EngineInterface) => {
  const repo = await $.session.repo().catch(() => null)
  return repo?.root ?? (await $.session.root())
}

const projectOf = async ($: EngineInterface) => basename(await projectRootOf($))

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
  const key = await secretOf($)
  const stored = found.map(f => idFor(key, f.m.key))
  found.forEach((f, i) => rawThisSession.set(stored[i] ?? f.m.fingerprint, f.m.value))

  await edit($, project, log => {
    found.forEach(({ m, p, action }, i) => {
      const id = stored[i] ?? m.fingerprint
      const prev = log[id]
      const hit: Hit = { at: now, via: p.via, source: p.source, session, action }
      log[id] = {
        id,
        kind: m.kind,
        category: m.category,
        // Secrets are never stored whole, whatever the setting
        value: s.storeRaw && m.category === 'private' ? m.value : m.masked,
        count: (prev?.count ?? 0) + 1,
        firstAt: prev?.firstAt ?? now,
        lastAt: now,
        hits: [hit, ...(prev?.hits ?? [])].slice(0, HITS_PER_FINDING),
      }
    })
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
        // Kinds a former version detected are dropped
        if (hits.length > 0 && isKind(f.kind)) out[f.id] = { ...f, hits }
      }
      return out
    })
  }
}

// This mod's rows in /config, `<plugin>.<field>`, whatever marketplace it came from
const OWN_ROW = /^leaks(?:@[^.]*)?\.(\w+)$/

// Takes a new value of the default mode, the rules or the ignore lists
function applySetting(s: Settings, field: string, value: unknown) {
  if (field === 'mode' && isMode(value)) s.mode = value
  if (typeof value !== 'string') return
  if (field === 'rules') {
    s.rulesText = value
    s.rules = parseRules(value, home)
  }
  if (field === 'ignore') s.ignore = parsePatterns(value, ',')
  if (field === 'folderIgnore') {
    s.folderIgnoreText = value
    s.folderIgnores = parseFolderIgnores(value, home)
  }
  skipCache.clear()
}

// Whether a value or source is ignored, for content tied to `paths`: the global entries and those of their folders
function skipFor(s: Settings, paths: readonly string[]) {
  const key = paths.join('\n')
  let skip = skipCache.get(key)
  if (!skip) {
    skip = matcher(patternsFor(s.ignore, s.folderIgnores, paths.filter(p => p !== '')))
    skipCache.set(key, skip)
  }
  return skip
}

type Field = 'mode' | 'rules' | 'ignore' | 'folderIgnore'
const FIELDS: readonly Field[] = ['mode', 'rules', 'ignore', 'folderIgnore']

// Changes made from the pane or the command while /config lists no row for this mod,
// each with the /config value it was made over: a later change there wins
const OVERRIDES = 'settings'
type Overrides = Partial<Record<Field, { value: string; base: string }>>

// Keeps a change in the store, or drops the one kept for `field`
async function keepOverride($: EngineInterface, field: Field, entry: { value: string; base: string } | null) {
  const run = async () => {
    const all = { ...(((await $.store.get(OVERRIDES)) ?? {}) as Overrides) }
    if (entry) all[field] = entry
    else if (field in all) delete all[field]
    else return
    if (Object.keys(all).length === 0) await $.store.delete(OVERRIDES)
    else await $.store.set(OVERRIDES, all)
  }
  queue = queue.then(run, run)
  return queue
}

// An ignore entry cannot hold the separators of the settings it is written in
const badPattern = (pattern: string) => (/[,|]/.test(pattern) || pattern.trim() === '' ? 'an entry cannot be empty or hold "," or "|"' : null)

// Writes one of this mod's settings as the /config menu would, or keeps it in the store
// when the engine lists no row for it; the reason when refused
async function writeSetting($: EngineInterface, s: Settings, field: Field, value: string): Promise<string | null> {
  const row = (await $.config.list()).find(r => OWN_ROW.exec(r.key)?.[1] === field)
  if (row) {
    const res = await $.config.set({ key: row.key, value })
    if (res.deny !== undefined) return res.deny
  }
  await keepOverride($, field, row ? null : { value, base: s.base[field] })
  applySetting(s, field, value)
  await update($, rev, n => (n ?? 0) + 1)
  return null
}

// Sets the mode of the current project's folder, or removes its rule
async function setHere($: EngineInterface, s: Settings, mode: Mode | null) {
  const path = await projectRootOf($)
  const deny = await writeSetting($, s, 'rules', formatRules(withRule(s.rules, path, mode), home))
  return { path, deny }
}

// Adds an entry to, or removes it from, the current project's ignore list
async function ignoreHere($: EngineInterface, s: Settings, pattern: string, add: boolean) {
  const path = await projectRootOf($)
  const deny = badPattern(pattern) ?? (await writeSetting($, s, 'folderIgnore', formatFolderIgnores(withIgnore(s.folderIgnores, path, pattern, add), home)))
  return { path, deny }
}

// Adds an entry to, or removes it from, the global ignore list
async function ignoreEverywhere($: EngineInterface, s: Settings, pattern: string, add: boolean) {
  const list = [...s.ignore.filter(p => p !== pattern), ...(add ? [pattern] : [])]
  return badPattern(pattern) ?? (await writeSetting($, s, 'ignore', list.join(',')))
}

// The mod's own sources and tests hold sample values, which would flag on every read
const DEFAULT_IGNORE = '*example.com,*example.org,*example.net,*noreply*,*no-reply*,git@github.com,git@gitlab.com,*plugins/leaks/hooks*'
const USAGE = [
  'Usage:',
  '/some-leaks opens the pane',
  '/some-leaks mode <off|notify|redact|block|default> sets this project',
  '/some-leaks default <off|notify|redact|block> sets the default',
  '/some-leaks ignore [--global] <entry> ignores a value in this project, or everywhere; * stands for any characters',
  '/some-leaks unignore [--global] <entry> stops ignoring it',
].join('\n')

export const register: Register = (on, options) => {
  const retentionDays = typeof options.retentionDays === 'number' ? options.retentionDays : 90
  const settings: Settings = {
    mode: isMode(options.mode) ? options.mode : 'redact',
    rules: [],
    // Parsed once the home folder is known, so `~` resolves
    rulesText: typeof options.rules === 'string' ? options.rules : '',
    notify: typeof options.notify === 'string' ? options.notify : 'toast',
    storeRaw: options.storeRawValues === true,
    failClosed: options.failClosed !== false,
    ignore: parsePatterns(typeof options.ignore === 'string' ? options.ignore : DEFAULT_IGNORE, ','),
    folderIgnores: [],
    folderIgnoreText: typeof options.folderIgnore === 'string' ? options.folderIgnore : '',
    base: {
      mode: typeof options.mode === 'string' ? options.mode : '',
      rules: typeof options.rules === 'string' ? options.rules : '',
      ignore: typeof options.ignore === 'string' ? options.ignore : '',
      folderIgnore: typeof options.folderIgnore === 'string' ? options.folderIgnore : '',
    },
  }

  const modeAt = (path: string): Mode => ruleFor(settings.rules, path)?.mode ?? settings.mode
  const sessionMode = (): Mode => (root ? modeAt(root) : settings.mode)
  const sessionScan = (): Scan => ({ mode: sessionMode(), skip: skipFor(settings, [root]) })
  // A file read takes the stricter of the session's mode and its own folder's, and both folders' ignore lists
  const callScan = (input: Record<string, unknown>): Scan => {
    const path = pathOf(input)
    if (!path) return sessionScan()
    const file = absolute(path, root)
    return { mode: stricter(sessionMode(), modeAt(file)), skip: skipFor(settings, [root, file]) }
  }
  // The strictest mode any part of the row is read in
  const rowMode = (e: SessionAppendInput) =>
    resultIds(e).reduce<Mode>((m, id) => stricter(m, toolCalls.get(id)?.mode ?? m), sessionMode())
  // In redact and block modes, a scan that fails or runs out of time withholds instead of letting data through
  const strictIn = (mode: Mode) => settings.failClosed && (mode === 'redact' || mode === 'block')
  const scanned = (e: SessionAppendInput) => e.door !== 'notice' && e.door !== 'compaction' && e.message.role !== undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'some-leaks',
      description: 'List the personal identifiers and secrets seen by the model, and set the mode per project',
    })
    root = await $.session.root()
    home = ((await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? '').replace(/\\/g, '/')
    // A change kept in the store applies unless /config changed since
    const overrides = ((await $.store.get(OVERRIDES).catch(() => undefined)) ?? {}) as Overrides
    for (const field of FIELDS) {
      const kept = overrides[field]
      if (kept?.base === settings.base[field]) applySetting(settings, field, kept.value)
      else if (kept) await keepOverride($, field, null)
    }
    settings.rules = parseRules(settings.rulesText, home)
    settings.folderIgnores = parseFolderIgnores(settings.folderIgnoreText, home)
    skipCache.clear()
    await prune($, retentionDays)
    return next(e)
  })

  // Writes what is still waiting before the session closes
  on('session.end', async ($, e, next) => {
    await flush($, settings).catch(() => undefined)
    return next(e)
  })

  // A change of this mod's mode or rules in /config applies at once
  on('config.set', async ($, e, next) => {
    const res = await next(e)
    const field = OWN_ROW.exec(e.key)?.[1]
    if (res.deny === undefined && field) {
      if ((FIELDS as readonly string[]).includes(field)) await keepOverride($, field as Field, null)
      applySetting(settings, field, res.value)
      await update($, rev, n => (n ?? 0) + 1)
    }
    return res
  })

  on('command.run', { command: 'some-leaks' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/)
    const verb = (words[0] ?? '').toLowerCase()
    const arg = (words[1] ?? '').toLowerCase()
    if (verb === 'ignore' || verb === 'unignore') {
      const global = words.slice(1).some(w => w.toLowerCase() === '--global')
      const pattern = words
        .slice(1)
        .filter(w => w.toLowerCase() !== '--global')
        .join(' ')
      if (pattern === '') return { text: USAGE }
      const add = verb === 'ignore'
      if (global) {
        const deny = await ignoreEverywhere($, settings, pattern, add)
        return { text: deny ? `Not changed: ${deny}` : `${pattern} is ${add ? 'now ignored' : 'no longer ignored'} everywhere.` }
      }
      const { path, deny } = await ignoreHere($, settings, pattern, add)
      return { text: deny ? `Not changed: ${deny}` : `${pattern} is ${add ? 'now ignored' : 'no longer ignored'} in ${tilde(path, home)}.` }
    }
    if (verb === 'mode' && (isMode(arg) || arg === 'default')) {
      const { path, deny } = await setHere($, settings, isMode(arg) ? arg : null)
      if (deny) return { text: `Not changed: ${deny}` }
      return { text: `${tilde(path, home)} now uses ${isMode(arg) ? `the ${arg} mode` : `the default mode (${settings.mode})`}.` }
    }
    if (verb === 'default' && isMode(arg)) {
      const deny = await writeSetting($, settings, 'mode', arg)
      return { text: deny ? `Not changed: ${deny}` : `Default mode is now ${arg}.` }
    }
    if (verb !== '') return { text: USAGE }
    await $.ui.open({ id: PANE, title: 'Leaks' })
    return { text: 'Leaks pane opened.' }
  })

  // Remembers what each tool call touched and the mode its result is read in;
  // in redact and block modes, refuses to write placeholders back over the real values
  on('tool.call', ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const scan = callScan(input)
    const mode = scan.mode
    toolCalls.set(e.tool_use_id, { ...scan, label: describeTool(String(e.tool), input, root) })
    if ((mode === 'redact' || mode === 'block') && WRITERS.has(String(e.tool)) && PLACEHOLDER.test(stringsOf(input).join('\n'))) {
      return {
        deny:
          'This input contains [redacted:...] placeholders the leaks mod put in place of personal identifiers or secrets. ' +
          'Writing it would replace the real values. Ask the user to make this change.',
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // In block mode, a prompt holding sensitive data is not sent and goes back to the prompt box
  on('prompt.submit', async ($, e, next) => {
    // The session's folder can change with /cd or a worktree move
    root = await $.session.root()
    const mode = sessionMode()
    if (mode !== 'block') return next(e)
    const g = guard(sessionScan(), { text: e.text, via: 'prompt', source: 'prompt' }, true)
    if (g.found.length === 0) return next(e)
    collect($, settings, g.found)
    if (e.origin.kind === 'composer') {
      const decorations = g.spans.map(sp => ({ start: sp.start, end: sp.end, underline: true, color: COLORS[sp.category] }))
      await $.prompt.fill({ text: e.text, decorations }).catch(() => undefined)
    }
    return { drop: `Not sent: the prompt contains ${kindsOf(g.found)} (leaks mod, block mode). Remove the underlined parts, or change the mode.` }
  }).catch(($, e, next) =>
    !next.called && strictIn(sessionMode()) && sessionMode() === 'block' ? { drop: 'Not sent: the leaks mod could not scan this prompt.' } : next(e),
  )

  // Every row the conversation keeps, as the model will read it
  on('session.append', async ($, e, next) => {
    if (!scanned(e) || rowMode(e) === 'off') return next(e)
    let guarded: ReturnType<typeof guardRow> | null = null
    try {
      guarded = guardRow(sessionScan(), e)
    } catch {
      if (strictIn(rowMode(e)) && e.door !== 'response') guarded = { message: withheldRow(e.message), found: [] }
    }
    const stored = await next(guarded && guarded.message !== e.message ? { ...e, message: guarded.message } : e)
    for (const id of resultIds(e)) toolCalls.delete(id)
    if (guarded) collect($, settings, guarded.found)
    return stored
  }).catch(($, e, next) =>
    !next.called && strictIn(rowMode(e)) && scanned(e) && e.door !== 'response' ? next({ ...e, message: withheldRow(e.message) }) : next(e),
  )

  on('model.complete', async ($, e, next) => {
    const mode = sessionMode()
    if (mode === 'off') return next(e)
    const s = sessionScan()
    const p = guard(s, { text: e.prompt, via: 'side-call', source: `complete ${e.model}` }, true)
    const sys = e.system === undefined ? null : guard(s, { text: e.system, via: 'side-call', source: `complete ${e.model}` }, true)
    const found = [...p.found, ...(sys?.found ?? [])]
    collect($, settings, found)
    if (found.length === 0 || mode === 'notify') return next(e)
    if (mode === 'block') return { deny: `Not sent: the request contains ${kindsOf(found)} (leaks mod, block mode)` }
    return next({ ...e, prompt: p.text, ...(sys ? { system: sys.text } : {}) })
  }).catch(($, e, next) => (!next.called && strictIn(sessionMode()) ? { deny: 'Not sent: the leaks mod could not scan this request' } : next(e)))

  on('model.fork', async ($, e, next) => {
    const mode = sessionMode()
    if (mode === 'off') return next(e)
    const p = guard(sessionScan(), { text: e.prompt, via: 'side-call', source: 'fork' }, true)
    collect($, settings, p.found)
    if (p.found.length === 0 || mode === 'notify') return next(e)
    if (mode === 'block') return { deny: `Not sent: the request contains ${kindsOf(p.found)} (leaks mod, block mode)` }
    return next({ ...e, prompt: p.text })
  }).catch(($, e, next) => (!next.called && strictIn(sessionMode()) ? { deny: 'Not sent: the leaks mod could not scan this request' } : next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Select = 'Select' in els ? els.Select : undefined
    await read($, rev)
    const v = await read($, view)
    const now = await $.clock.now()
    const here = await projectRootOf($)
    const current = basename(here)
    const projects = (await $.store.keys())
      .filter(k => k.startsWith(PROJECT_PREFIX))
      .map(k => k.slice(PROJECT_PREFIX.length))
    if (!projects.includes(current)) projects.push(current)
    projects.sort()
    const shown = v.project ?? current
    const log = await loadProject($, shown)
    const filter = FILTERS.some(f => f.id === v.filter) ? v.filter : 'all'
    const tab = TABS.some(t => t.id === v.tab) ? v.tab : 'findings'
    // Kinds a former version detected are left out until the next prune
    const all = Object.values(log).filter(f => isKind(f.kind))
    const findings = all
      .filter(f => filter === 'all' || f.category === filter)
      .sort((a, b) => b.lastAt - a.lastAt)
    const cols = Math.max(32, e.props.bodyColumns)
    const sessionRule = root ? ruleFor(settings.rules, root) : null
    const modeLine = `Mode here: ${sessionMode()}, ${sessionRule ? `rule for ${tilde(sessionRule.path, home)}` : 'default'}`

    const set = (patch: Partial<LeaksView>) => () => void update($, view, cur => ({ ...cur, confirmClear: false, notice: null, ...patch }))
    const pickProject = (value: string) =>
      void update($, view, cur => ({ ...cur, confirmClear: false, project: value === current ? null : value }))
    const clear = async () => {
      await edit($, shown, () => ({}))
      seenThisSession.clear()
      await update($, view, cur => ({ ...cur, confirmClear: false }))
      await update($, rev, n => (n ?? 0) + 1)
    }
    const notice = (deny: string | null) => update($, view, cur => ({ ...cur, notice: deny ? `Not changed: ${deny}` : null }))
    const chooseHere = (mode: Mode | null) => async () => notice((await setHere($, settings, mode)).deny)
    const chooseDefault = (mode: Mode) => async () => notice(await writeSetting($, settings, 'mode', mode))
    const removeRule = (path: string) => async () =>
      notice(await writeSetting($, settings, 'rules', formatRules(withRule(settings.rules, path, null), home)))
    const ignoreValue = (value: string, global: boolean) => async () =>
      notice(global ? await ignoreEverywhere($, settings, value, true) : (await ignoreHere($, settings, value, true)).deny)
    const removeGlobalIgnore = (pattern: string) => async () => notice(await ignoreEverywhere($, settings, pattern, false))
    const removeFolderIgnore = (path: string, pattern: string) => async () =>
      notice(await writeSetting($, settings, 'folderIgnore', formatFolderIgnores(withIgnore(settings.folderIgnores, path, pattern, false), home)))

    const counts = {
      private: all.filter(f => f.category === 'private').length,
      secret: all.filter(f => f.category === 'secret').length,
      hits: all.reduce((s, f) => s + f.count, 0),
    }
    const last = all.reduce((t, f) => Math.max(t, f.lastAt), 0)

    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {TABS.map(t => (
            <Button key={`tab-${t.id}`} label={t.label} hotkey={t.hotkey} variant={tab === t.id ? 'primary' : 'secondary'} onPress={set({ tab: t.id })} />
          ))}
          {tab !== 'rules' &&
            FILTERS.map(f => (
              <Button key={`filter-${f.id}`} label={f.label} hotkey={f.hotkey} variant={filter === f.id ? 'primary' : 'secondary'} onPress={set({ filter: f.id })} />
            ))}
          {tab !== 'rules' && Select && projects.length > 1 && (
            <Select key="project" options={projects.map(p => ({ value: p, label: p === current ? `${p} (current)` : p }))} value={shown} onSelect={pickProject} />
          )}
        </Box>
        <Box key="summary" flexDirection="column">
          <Text bold>{shown}</Text>
          <Text dimColor>{clip(modeLine, cols)}</Text>
          <Text dimColor>
            {all.length === 0
              ? 'Nothing seen yet'
              : `${counts.private} private, ${counts.secret} secret, ${counts.hits} occurrences, last ${fmtWhen(last, now)}`}
          </Text>
        </Box>
        {v.notice ? <Text key="notice" color="red">{v.notice}</Text> : null}
      </Box>
    )

    if (tab === 'rules') {
      const exact = settings.rules.find(r => r.path === here.replace(/\\/g, '/'))
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box key="modes-here" flexDirection="column">
            <Text bold>This project</Text>
            <Text dimColor>{clip(tilde(here, home), cols)}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {MODES.map(m => (
              <Button key={`here-${m}`} label={MODE_LABELS[m]} variant={exact?.mode === m ? 'primary' : 'secondary'} onPress={chooseHere(m)} />
            ))}
            <Button key="here-default" label={`Default (${settings.mode})`} variant={exact ? 'secondary' : 'primary'} onPress={chooseHere(null)} />
          </Box>
          <Text bold>Default mode</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {MODES.map(m => (
              <Button key={`default-${m}`} label={MODE_LABELS[m]} variant={settings.mode === m ? 'primary' : 'secondary'} onPress={chooseDefault(m)} />
            ))}
          </Box>
          <Text bold>Mode rules</Text>
          <Box key="rules" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {settings.rules.length === 0 ? (
              <Text dimColor>No rules: every folder uses the default mode</Text>
            ) : (
              settings.rules.map((r, i) => (
                <Box key={`rule-${i}`} flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                  <Text>{clip(`${tilde(r.path, home)} = ${r.mode}`, Math.max(12, cols - 14))}</Text>
                  <Button key={`rule-remove-${i}`} label="Remove" onPress={removeRule(r.path)} />
                </Box>
              ))
            )}
          </Box>
          <Text dimColor>A file read takes the stricter of the session's mode and its own folder's.</Text>
          <Text bold>Ignored everywhere</Text>
          <Box key="ignore-global" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {settings.ignore.length === 0 ? (
              <Text dimColor>Nothing</Text>
            ) : (
              settings.ignore.map((p, i) => (
                <Box key={`ignore-global-${i}`} flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                  <Text>{clip(p, Math.max(12, cols - 14))}</Text>
                  <Button key={`ignore-global-remove-${i}`} label="Remove" onPress={removeGlobalIgnore(p)} />
                </Box>
              ))
            )}
          </Box>
          <Text bold>Ignored per folder</Text>
          <Box key="ignore-folders" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {settings.folderIgnores.length === 0 ? (
              <Text dimColor>Nothing</Text>
            ) : (
              settings.folderIgnores.flatMap((f, i) =>
                f.patterns.map((p, j) => (
                  <Box key={`ignore-folder-${i}-${j}`} flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                    <Text>{clip(`${tilde(f.path, home)}: ${p}`, Math.max(12, cols - 14))}</Text>
                    <Button key={`ignore-folder-remove-${i}-${j}`} label="Remove" onPress={removeFolderIgnore(f.path, p)} />
                  </Box>
                )),
              )
            )}
          </Box>
          <Text dimColor>In an entry, * stands for any characters: *@acme.com ignores a whole domain. Add one from a finding, or with /some-leaks ignore.</Text>
        </Box>
      )
    }

    if (findings.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor>
            {filter === 'secret' ? 'No secrets' : `No ${filter === 'private' ? 'private' : 'sensitive'} data`} seen by the model in this project.
          </Text>
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
    if (tab === 'findings') {
      body = findings.map(f => {
        const latest = f.hits[0]
        // Only this session's findings can be ignored from here: stored values are masked
        const raw = shown === current ? rawThisSession.get(f.id) : undefined
        return (
          <Box key={`finding-${f.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {chip(f)}
              <Text>{clip(f.value, Math.max(12, cols - 30))}</Text>
              <Text dimColor>x{f.count}</Text>
            </Box>
            <Text dimColor>{`  last ${fmtWhen(f.lastAt, now)}, first ${fmtWhen(f.firstAt, now)}`}</Text>
            {latest && <Text dimColor>{`  ${origin(latest)}`}</Text>}
            {raw !== undefined && (
              <Box flexDirection="row" gap={1}>
                <Button key={`ignore-here-${f.id}`} label="Ignore here" onPress={ignoreValue(raw, false)} />
                <Button key={`ignore-all-${f.id}`} label="Ignore everywhere" onPress={ignoreValue(raw, true)} />
              </Box>
            )}
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
