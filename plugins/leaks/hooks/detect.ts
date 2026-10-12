// Private and medical data detectors: pure functions, no engine access

export type Category = 'private' | 'medical'

export type Kind = 'email' | 'phone' | 'iban' | 'card' | 'nir' | 'ssn' | 'birthdate' | 'health'

export type Match = {
  kind: Kind
  category: Category
  // The text as found
  value: string
  // The text with its identifying part hidden
  masked: string
  // Stable id of the value, for de-duplication
  fingerprint: string
}

export const KINDS: Record<Kind, { label: string; category: Category }> = {
  email: { label: 'Email', category: 'private' },
  phone: { label: 'Phone', category: 'private' },
  iban: { label: 'IBAN', category: 'private' },
  card: { label: 'Card number', category: 'private' },
  nir: { label: 'Social security (FR)', category: 'private' },
  ssn: { label: 'SSN (US)', category: 'private' },
  birthdate: { label: 'Date of birth', category: 'private' },
  health: { label: 'Health term', category: 'medical' },
}

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

const boring = (digits: string) => /^(\d)\1+$/.test(digits) || '01234567890123456789'.includes(digits)

type Detector = {
  kind: Kind
  re: RegExp
  check?: (m: RegExpExecArray) => boolean
  value?: (m: RegExpExecArray) => string
  mask: (value: string) => string
  norm: (value: string) => string
}

const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'js', 'ts', 'tsx', 'css', 'json', 'md', 'lock'])

// Health terms matched in any case
const HEALTH_WORDS = [
  'diagnosis', 'diagnoses', 'diagnosed with', 'diagnostiquée?s?',
  'prescription', 'prescribed', 'ordonnance médicale',
  'medical records?', 'medical history', 'health records?', 'dossier médical', 'antécédents médicaux', 'carnet de santé',
  'blood type', 'groupe sanguin',
  'cancers?', 'tumou?rs?', 'tumeurs?', 'chemotherapy', 'chimiothérapie', 'radiotherapy', 'radiothérapie', 'oncology', 'oncologie',
  'diabetes', 'diabetic', 'diabète', 'diabétique',
  'depression', 'dépression', 'depressive', 'dépressi(?:f|ve)', 'antidepressants?', 'antidépresseurs?',
  'bipolar', 'bipolaire', 'schizophrenia', 'schizophrénie', 'schizophrène', 'psychosis', 'psychose',
  'psychiatric', 'psychiatrique', 'psychiatrist', 'psychiatre',
  'suicidal', 'suicidaire', 'suicide attempt', 'tentative de suicide',
  'epilepsy', 'épilepsie', 'asthma', 'asthme', 'hepatitis', 'hépatite', 'tuberculosis', 'tuberculose',
  'pregnancy', 'pregnant', 'grossesse', 'abortion', 'avortement', 'miscarriage', 'fausse couche',
  "alzheimer's?", 'parkinson', 'autism', 'autistic', 'autisme', 'autiste',
  'anorexia', 'anorexie', 'bulimia', 'boulimie',
  'disability', 'handicapée?', 'allerg(?:y|ies|ic)', 'allergies?', 'allergique',
  'insulin', 'insuline', 'sick leave', 'arrêt maladie', 'arrêt de travail', 'medical certificate', 'certificat médical',
  'carte vitale',
  'xanax', 'prozac', 'zoloft', 'lexomil', 'levothyrox', 'ritalin', 'ritaline', 'subutex', 'truvada', 'metformine?',
]

// Health acronyms, matched in capitals only ("AIDS" yes, "aids" no)
const HEALTH_ACRONYMS = ['HIV', 'VIH', 'AIDS', 'SIDA', 'ADHD', 'TDAH', 'PTSD', 'TSPT', 'IVG', 'COPD', 'BPCO']

const edge = (alts: string[]) => `(?<![\\p{L}\\p{N}_])(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`

const DETECTORS: Detector[] = [
  {
    kind: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,24})\b/g,
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
    check: m => ibanValid(m[0]),
    mask: v => maskAlnum(v, 4, 4),
    norm: v => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    kind: 'card',
    re: /(?<![\d-])[3-6]\d{3}(?:[ -]?\d){9,15}(?![\d-])/g,
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
    check: m => nirValid(m[0]),
    mask: v => maskAlnum(v, 1, 2),
    norm: v => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    kind: 'ssn',
    re: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g,
    mask: v => maskAlnum(v, 0, 4),
    norm: digitsOf,
  },
  {
    kind: 'phone',
    // French numbers, local or +33
    re: /(?<![\w+])(?:(?:\+|00)33[ .-]?|0)[1-9](?:[ .-]?\d{2}){4}(?!\d)/g,
    check: m => !boring(digitsOf(m[0])),
    mask: v => maskAlnum(v, 0, 2),
    norm: v => digitsOf(v).replace(/^(?:0033|33)/, '0'),
  },
  {
    kind: 'phone',
    // Other international numbers, written with a leading +
    re: /(?<![\w+])\+(?!33)[1-9]\d{0,2}(?:[ .-]?\(?\d{2,4}\)?){2,5}(?!\d)/g,
    check: m => {
      const n = digitsOf(m[0]).length
      return n >= 8 && n <= 15
    },
    mask: v => maskAlnum(v, 0, 2),
    norm: digitsOf,
  },
  {
    kind: 'birthdate',
    re: /(?:date of birth|birth ?date|d\.o\.b\.?|\bdob|\bborn(?: on)?|\bnée? le|date de naissance)["']?\s*[:=]?\s*["']?(\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}|(?:19|20)\d{2}-\d{2}-\d{2})/gi,
    value: m => m[1] ?? m[0],
    mask: v => (/^\d{4}/.test(v) ? v.replace(/(?<=^\d{4}.*)\d/g, '*') : v.replace(/\d(?=.*\d{4}$)/g, '*')),
    norm: digitsOf,
  },
  {
    kind: 'health',
    re: new RegExp(edge(HEALTH_WORDS), 'giu'),
    mask: v => v.toLowerCase(),
    norm: v => v.toLowerCase(),
  },
  {
    kind: 'health',
    re: new RegExp(edge(HEALTH_ACRONYMS), 'gu'),
    mask: v => v,
    norm: v => v.toUpperCase(),
  },
  {
    kind: 'health',
    re: /\b(?:ICD-?10|CIM-?10)\s*[:-]?\s*[A-TV-Z]\d{2}(?:\.\d{1,2})?\b/gi,
    mask: v => v,
    norm: v => v.toUpperCase().replace(/\s/g, ''),
  },
]

export type Span = Match & { start: number; end: number }

// Every occurrence of a private or medical value in `text`, minus those `ignore` names
export const spansOf = (text: string, ignore: readonly string[] = []): Span[] => {
  const out: Span[] = []
  // Spans already claimed, so an IBAN's digits are not also a card or a phone
  const taken: [number, number][] = []
  for (const d of DETECTORS) {
    d.re.lastIndex = 0
    for (let m = d.re.exec(text); m !== null; m = d.re.exec(text)) {
      const start = m.index
      const end = start + m[0].length
      if (d.check && !d.check(m)) continue
      if (d.kind !== 'health' && taken.some(([a, b]) => start < b && end > a)) continue
      const raw = d.value ? d.value(m) : m[0]
      const value = raw.trim()
      const lower = value.toLowerCase()
      if (ignore.some(i => lower.includes(i))) continue
      taken.push([start, end])
      // A value inside the match (a date after its label) is the part redacted
      const at = start + m[0].indexOf(raw) + (raw.length - raw.trimStart().length)
      out.push({
        kind: d.kind,
        category: KINDS[d.kind].category,
        value,
        masked: d.mask(value),
        fingerprint: fnv1a(`${d.kind}:${d.norm(value)}`),
        start: at,
        end: at + value.length,
      })
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end)
}

// Every private or medical value in `text`, once each
export const detect = (text: string, ignore: readonly string[] = []): Match[] => {
  const found = new Map<string, Match>()
  for (const { start: _s, end: _e, ...m } of spansOf(text, ignore)) if (!found.has(m.fingerprint)) found.set(m.fingerprint, m)
  return [...found.values()]
}

export const placeholder = (kind: Kind) => `[redacted:${kind}]`

// Matches the placeholders `redact` writes
export const PLACEHOLDER = /\[redacted:[a-z]+\]/

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
