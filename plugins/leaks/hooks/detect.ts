// Personal identifiers and secrets detectors: pure functions, no engine access

export type Category = 'private' | 'secret'

export type Kind =
  | 'email'
  | 'phone'
  | 'iban'
  | 'card'
  | 'nir'
  | 'be-nrn'
  | 'es-dni'
  | 'it-cf'
  | 'ssn'
  | 'api-key'
  | 'private-key'
  | 'url-password'
  | 'jwt'

export type Match = {
  kind: Kind
  category: Category
  // The text as found
  value: string
  // The text with its identifying part hidden
  masked: string
  // Stable id of the value, for de-duplication within a session; kept in memory only
  fingerprint: string
  // Kind and normalized value, from which the stored id is derived; kept in memory only
  key: string
}

export const KINDS: Record<Kind, { label: string; category: Category }> = {
  email: { label: 'Email', category: 'private' },
  phone: { label: 'Phone', category: 'private' },
  iban: { label: 'IBAN', category: 'private' },
  card: { label: 'Card number', category: 'private' },
  nir: { label: 'Social security (FR)', category: 'private' },
  'be-nrn': { label: 'National number (BE)', category: 'private' },
  'es-dni': { label: 'DNI/NIE (ES)', category: 'private' },
  'it-cf': { label: 'Codice fiscale (IT)', category: 'private' },
  ssn: { label: 'SSN (US)', category: 'private' },
  'api-key': { label: 'API key', category: 'secret' },
  'private-key': { label: 'Private key', category: 'secret' },
  'url-password': { label: 'URL password', category: 'secret' },
  jwt: { label: 'JWT', category: 'secret' },
}

export const isKind = (k: unknown): k is Kind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(KINDS, k)

// FNV-1a, 32 bits, as 8 hex chars
export const fnv1a = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const digitsOf = (s: string) => s.replace(/\D/g, '')

// Hides every letter or digit except the first `head` and last `tail` of them
const maskAlnum = (s: string, head: number, tail: number) => {
  const total = (s.match(/[A-Za-z0-9]/g) ?? []).length
  let i = 0
  return s.replace(/[A-Za-z0-9]/g, c => {
    const at = i++
    return at < head || at >= total - tail ? c : '*'
  })
}

const luhn = (digits: string) => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

const ibanValid = (raw: string) => {
  const s = raw.replace(/\s/g, '').toUpperCase()
  if (s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const c of moved) {
    const v = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c
    for (const d of v) rest = (rest * 10 + Number(d)) % 97
  }
  return rest === 1
}

const nirValid = (raw: string) => {
  const s = raw.replace(/\s/g, '').toUpperCase()
  const body = s.slice(0, 13).replace('2A', '19').replace('2B', '18')
  const key = Number(s.slice(13))
  return 97 - (Number(body) % 97) === key
}

// Belgian national register number: a birth date, a serial and a mod-97 key, with a 2 in front for births from 2000
const beValid = (raw: string) => {
  const d = digitsOf(raw)
  const month = Number(d.slice(2, 4))
  if (!(month <= 12 || (month >= 20 && month <= 32) || (month >= 40 && month <= 52))) return false
  if (Number(d.slice(4, 6)) > 31) return false
  const body = Number(d.slice(0, 9))
  const key = Number(d.slice(9))
  return 97 - (body % 97) === key || 97 - ((2e9 + body) % 97) === key
}

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE'

// Spanish DNI (8 digits) or NIE (X, Y or Z and 7 digits), and their mod-23 letter
const dniValid = (raw: string) => {
  const s = raw.replace('-', '').toUpperCase()
  const n = Number(s.slice(0, -1).replace(/^[XYZ]/, c => String('XYZ'.indexOf(c))))
  return DNI_LETTERS[n % 23] === s.slice(-1)
}

// Italian codice fiscale: values of each character in odd positions (1st, 3rd...), digits then letters
const CF_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23]

const cfValid = (raw: string) => {
  const s = raw.toUpperCase()
  let sum = 0
  for (let i = 0; i < 15; i++) {
    const c = s.charCodeAt(i)
    const v = c <= 57 ? c - 48 : c - 55
    sum += i % 2 === 0 ? (CF_ODD[v] ?? 0) : v <= 9 ? v : v - 10
  }
  return String.fromCharCode(65 + (sum % 26)) === s[15]
}

const boring = (digits: string) => /^(\d)\1+$/.test(digits) || '01234567890123456789'.includes(digits)

// Two-digit country calling codes; 1 and 7 are the one-digit ones, every other code has three digits
const CC2 = new Set(
  '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'.split(' '),
)

// National number lengths where they are fixed or well bounded; others take 6 to 12 digits
const NSN: Record<string, readonly [number, number]> = {
  '1': [10, 10],
  '7': [10, 10],
  '31': [9, 9],
  '32': [8, 9],
  '33': [9, 9],
  '34': [9, 9],
  '39': [6, 11],
  '41': [9, 9],
  '44': [9, 10],
  '49': [6, 13],
  '212': [9, 9],
  '213': [8, 9],
  '216': [8, 8],
  '351': [9, 9],
  '352': [4, 11],
}

// The number in international form: + and the digits, without the "(0)" some write after the country code
const phoneNorm = (raw: string) => `+${digitsOf(raw.replace('(0)', '')).replace(/^00/, '')}`

const phoneValid = (raw: string) => {
  const d = phoneNorm(raw).slice(1)
  const cc = d[0] === '1' || d[0] === '7' ? d.slice(0, 1) : CC2.has(d.slice(0, 2)) ? d.slice(0, 2) : d.slice(0, 3)
  const nsn = d.slice(cc.length)
  const [min, max] = NSN[cc] ?? [6, 12]
  if (nsn.length < min || nsn.length > max || d.length > 15 || boring(nsn)) return false
  if (cc === '1') return /^[2-9]\d\d[2-9]/.test(nsn)
  return nsn[0] !== '0'
}

// A phone match followed by another group of digits is part of a longer number
const continued = (m: RegExpExecArray) => /^[ .-]?\d/.test(m.input.slice(m.index + m[0].length, m.index + m[0].length + 2))

// What a text holds, checked once, so detectors that cannot match are skipped
type Traits = { at: boolean; dash: boolean; digit: boolean; scheme: boolean; pem: boolean; jwt: boolean }

type Detector = {
  kind: Kind
  re: RegExp
  need?: (t: Traits) => boolean
  check?: (m: RegExpExecArray) => boolean
  // The part of the match that is the value, and where it starts in the match; the whole match by default
  part?: (m: RegExpExecArray) => readonly [number, string]
  mask: (value: string, m: RegExpExecArray) => string
  norm: (value: string, m: RegExpExecArray) => string
}

const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'js', 'ts', 'tsx', 'css', 'json', 'md', 'lock'])

// Credentials in documentation and config templates, not real ones
const PLACEHOLDER_PASSWORDS = new Set(['password', 'pass', 'pwd', 'secret', 'xxx', 'xxxx'])

const API_KEYS = [
  '(?:AKIA|ASIA)[0-9A-Z]{16}',
  'gh[pousr]_[A-Za-z0-9]{36,}',
  'github_pat_[A-Za-z0-9_]{22,}',
  'glpat-[A-Za-z0-9_-]{20,}',
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}',
  '[sr]k_(?:live|test)_[A-Za-z0-9]{16,}',
  'xox[abposr]-[A-Za-z0-9-]{10,}',
  'hooks\\.slack\\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+',
  'AIza[0-9A-Za-z_-]{35}',
  'npm_[A-Za-z0-9]{36}',
  'SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}',
  'hf_[A-Za-z0-9]{34,}',
]

const keep = (head: number, tail: number) => (v: string) => `${v.slice(0, head)}****${v.slice(-tail)}`

const DETECTORS: Detector[] = [
  {
    kind: 'private-key',
    // The body stops at the first run of five dashes; "\\n" keeps keys escaped inside JSON strings whole
    re: /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----(?:[A-Za-z0-9+/=\s:,.\\]|-(?!----))*(?:-----END ([A-Z0-9]+ )*PRIVATE KEY-----)?/g,
    need: t => t.pem,
    mask: v => v.slice(0, v.indexOf('KEY-----') + 8),
    norm: v => v.replace(/\s|\\n/g, ''),
  },
  {
    kind: 'jwt',
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
    need: t => t.jwt,
    mask: v => `eyJ**** (${v.length} chars)`,
    norm: v => v,
  },
  {
    kind: 'api-key',
    re: new RegExp(`(?<![A-Za-z0-9_-])(?:${API_KEYS.join('|')})(?![A-Za-z0-9_-])`, 'g'),
    mask: keep(4, 4),
    norm: v => v,
  },
  {
    kind: 'url-password',
    // Only the password is the value; the scheme, user and host stay readable
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'<>]{1,128}:)([^\s@/"'<>]{1,256})@([^\s/?#"'<>]{1,253})/gi,
    need: t => t.scheme && t.at,
    check: m => {
      const pw = m[2] ?? ''
      return !/^[$%{<*]/.test(pw) && !PLACEHOLDER_PASSWORDS.has(pw.toLowerCase())
    },
    part: m => [(m[1] ?? '').length, m[2] ?? ''],
    mask: (v, m) => `${m[1] ?? ''}***@${m[3] ?? ''}`,
    norm: (v, m) => `${(m[1] ?? '').toLowerCase()}${v}@${(m[3] ?? '').toLowerCase()}`,
  },
  {
    kind: 'email',
    // Starts only where a run of address characters starts, and bounded to the RFC limits,
    // so a long unbroken run of letters costs one pass instead of one pass per position
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.([A-Za-z]{2,24})\b/g,
    need: t => t.at,
    check: m => !FILE_TLDS.has((m[1] ?? '').toLowerCase()),
    mask: v => {
      const [local = '', domain = ''] = v.split('@')
      return `${local.slice(0, 1)}***@${domain}`
    },
    norm: v => v.toLowerCase(),
  },
  {
    kind: 'iban',
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    need: t => t.digit,
    check: m => ibanValid(m[0]),
    mask: v => maskAlnum(v, 4, 4),
    norm: v => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    kind: 'card',
    re: /(?<![\d-])[3-6]\d{3}(?:[ -]?\d){9,15}(?![\d-])/g,
    need: t => t.digit,
    check: m => {
      const d = digitsOf(m[0])
      return d.length >= 13 && d.length <= 19 && !boring(d) && luhn(d)
    },
    mask: v => maskAlnum(v, 0, 4),
    norm: digitsOf,
  },
  {
    kind: 'nir',
    re: /(?<![\w])[12] ?\d{2} ?(?:0[1-9]|1[0-2]|[2-9]\d) ?(?:\d{2}|2A|2B) ?\d{3} ?\d{3} ?\d{2}(?!\d)/g,
    need: t => t.digit,
    check: m => nirValid(m[0]),
    mask: v => maskAlnum(v, 1, 2),
    norm: v => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    kind: 'phone',
    // International form, + or 00 then the country code; the country code and length are checked after
    re: /(?<![\w+])(?:\+|00)[1-9][\d .()/-]{5,22}\d/g,
    need: t => t.digit,
    check: m => !continued(m) && phoneValid(m[0]),
    mask: v => maskAlnum(v, 0, 2),
    norm: phoneNorm,
  },
  {
    kind: 'phone',
    // French national form, 0 then 9 digits; stored as +33 so both forms are one value
    re: /(?<![\w+.])0[1-9](?:[ .-]?\d{2}){4}(?!\d)/g,
    need: t => t.digit,
    check: m => !continued(m) && !boring(digitsOf(m[0])),
    mask: v => maskAlnum(v, 0, 2),
    norm: v => `+33${digitsOf(v).slice(1)}`,
  },
  {
    kind: 'be-nrn',
    re: /(?<![\d.])\d{2}\.?\d{2}\.?\d{2}[-.]?\d{3}\.?\d{2}(?![\d])/g,
    need: t => t.digit,
    check: m => beValid(m[0]),
    mask: v => maskAlnum(v, 0, 2),
    norm: digitsOf,
  },
  {
    kind: 'es-dni',
    re: /(?<![A-Za-z0-9])(?:\d{8}|[XYZ]\d{7})-?[A-Z](?![A-Za-z0-9])/g,
    need: t => t.digit,
    check: m => dniValid(m[0]),
    mask: v => maskAlnum(v, 0, 1),
    norm: v => v.replace('-', '').toUpperCase(),
  },
  {
    kind: 'it-cf',
    // Digits may be replaced by L to V when two people share a code
    re: /(?<![A-Za-z0-9])[A-Z]{6}[\dLMNP-V]{2}[ABCDEHLMPRST][\dLMNP-V]{2}[A-Z][\dLMNP-V]{3}[A-Z](?![A-Za-z0-9])/gi,
    need: t => t.digit,
    check: m => cfValid(m[0]),
    mask: v => maskAlnum(v, 0, 1),
    norm: v => v.toUpperCase(),
  },
  {
    kind: 'ssn',
    re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
    need: t => t.dash && t.digit,
    mask: v => maskAlnum(v, 0, 4),
    norm: digitsOf,
  },
]

export type Span = Match & { start: number; end: number }

// Every occurrence of a personal identifier or secret in `text`, minus the values `skip` answers true for
export const spansOf = (text: string, skip?: (value: string) => boolean): Span[] => {
  const out: Span[] = []
  const traits: Traits = {
    at: text.includes('@'),
    dash: text.includes('-'),
    digit: /\d/.test(text),
    scheme: text.includes('://'),
    pem: text.includes('PRIVATE KEY-----'),
    jwt: text.includes('eyJ'),
  }
  // Characters already claimed, so an IBAN's digits are not also a card or a phone; made on the first claim
  let taken: Uint8Array | null = null
  for (const d of DETECTORS) {
    if (d.need && !d.need(traits)) continue
    d.re.lastIndex = 0
    for (let m = d.re.exec(text); m !== null; m = d.re.exec(text)) {
      if (d.check && !d.check(m)) continue
      const [offset, value] = d.part ? d.part(m) : [0, m[0]]
      const start = m.index + offset
      const end = start + value.length
      if (taken !== null && taken.subarray(start, end).includes(1)) continue
      if (skip?.(value)) continue
      ;(taken ??= new Uint8Array(text.length)).fill(1, start, end)
      const key = `${d.kind}:${d.norm(value, m)}`
      out.push({
        kind: d.kind,
        category: KINDS[d.kind].category,
        value,
        masked: d.mask(value, m),
        fingerprint: fnv1a(key),
        key,
        start,
        end,
      })
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end)
}

// Every personal identifier or secret in `text`, once each
export const detect = (text: string, skip?: (value: string) => boolean): Match[] => {
  const found = new Map<string, Match>()
  for (const { start: _s, end: _e, ...m } of spansOf(text, skip)) if (!found.has(m.fingerprint)) found.set(m.fingerprint, m)
  return [...found.values()]
}

export const placeholder = (kind: Kind) => `[redacted:${kind}]`

// Matches the placeholders `redact` writes
export const PLACEHOLDER = /\[redacted:[a-z-]+\]/

// `text` with each span replaced by its placeholder; overlapping spans keep the first
export const redact = (text: string, spans: readonly Span[]) => {
  let out = ''
  let at = 0
  for (const sp of spans) {
    if (sp.start < at) continue
    out += text.slice(at, sp.start) + placeholder(sp.kind)
    at = sp.end
  }
  return out + text.slice(at)
}
