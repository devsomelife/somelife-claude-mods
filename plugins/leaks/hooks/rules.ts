// Modes per folder: pure functions, no engine access

export type Mode = 'off' | 'notify' | 'redact' | 'block'

// Least strict first
export const MODES: readonly Mode[] = ['off', 'notify', 'redact', 'block']

export const isMode = (m: unknown): m is Mode => typeof m === 'string' && (MODES as readonly string[]).includes(m)

export const stricter = (a: Mode, b: Mode): Mode => (MODES.indexOf(a) >= MODES.indexOf(b) ? a : b)

// A folder, absolute, with forward slashes and no trailing slash, and the mode for everything beneath it
export type Rule = { path: string; mode: Mode }

const clean = (p: string) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

const expand = (p: string, home: string) => (home && (p === '~' || p.startsWith('~/')) ? home + p.slice(1) : p)

export const tilde = (p: string, home: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p)

// `~/clients/acme=block, /srv/data=redact`: entries that are not an absolute folder and a mode are skipped
export const parseRules = (text: string, home: string): Rule[] =>
  text.split(',').flatMap(entry => {
    const at = entry.lastIndexOf('=')
    if (at <= 0) return []
    const mode = entry.slice(at + 1).trim().toLowerCase()
    const path = clean(expand(entry.slice(0, at).trim(), clean(home)))
    return isMode(mode) && isAbsolute(path) ? [{ path, mode }] : []
  })

export const formatRules = (rules: readonly Rule[], home: string) => rules.map(r => `${tilde(r.path, clean(home))}=${r.mode}`).join(', ')

// The path made absolute against `root`, cleaned the way rule paths are
export const absolute = (path: string, root: string) => {
  const p = clean(path)
  return isAbsolute(p) || !root ? p : clean(`${root}/${p.replace(/^\.\//, '')}`)
}

const covers = (rule: string, path: string) => path === rule || path.startsWith(rule === '/' ? '/' : `${rule}/`)

// The rule of the deepest folder holding `path`, or null
export const ruleFor = (rules: readonly Rule[], path: string): Rule | null => {
  let best: Rule | null = null
  for (const r of rules) if (covers(r.path, path) && (best === null || r.path.length > best.path.length)) best = r
  return best
}

// The rules with `path` set to `mode`, or its rule removed when `mode` is null
export const withRule = (rules: readonly Rule[], path: string, mode: Mode | null): Rule[] => {
  const p = clean(path)
  const rest = rules.filter(r => r.path !== p)
  return mode === null ? rest : [...rest, { path: p, mode }]
}
