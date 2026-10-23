import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionAppendInput } from 'claude-code'

import { detect, fnv1a, placeholder, redact, spansOf } from './detect'
import { describeTool, guard, idFor, withheldRow } from './register'
import {
  absolute,
  formatFolderIgnores,
  formatRules,
  matcher,
  parseFolderIgnores,
  parsePatterns,
  parseRules,
  patternsFor,
  ruleFor,
  stricter,
  withIgnore,
  withRule,
} from './rules'

// 2026-10-12 at 14:02 local time
const NOW = new Date(2026, 9, 12, 14, 2).getTime()

const PANE = {
  plugin: 'leaks',
  component: 'Pane',
  requestId: 'leaks',
  props: {
    title: 'Leaks',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Past the mod's wait before it writes findings
const FLUSH_MS = 250

const START = { cwd: '/home/me/workspaces/clinic', surface: 'terminal', isInteractive: true } as const

const session = (on: On) => {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  const rows = mock.session(on)
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: '/home/me/workspaces/clinic' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.start', ($, e) => e)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  return { toasts, rows, settle: () => clock.advance(FLUSH_MS) }
}

const toolResult = (id: string, text: string): SessionAppendInput => ({
  door: 'tool-result',
  origin: { kind: 'tool', tool: 'Read' },
  uuid: `row-${id}`,
  message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
})

const prompt = (text: string): SessionAppendInput => ({
  door: 'prompt',
  origin: { kind: 'composer' },
  uuid: 'row-prompt',
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
})

const reply = (text: string): SessionAppendInput => ({
  door: 'response',
  origin: { kind: 'model', model: 'claude-opus-5-5' },
  uuid: 'row-reply',
  message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
})

// What the conversation kept for the row `uuid`, as the model reads it
const keptText = (rows: { appended: () => readonly SessionAppendInput[] }, uuid: string) =>
  JSON.stringify(rows.appended().find(r => r.uuid === uuid)?.message.content)

const kinds = (text: string) => detect(text).map(m => `${m.kind}:${m.masked}`)

test('finds personal identifiers and masks them', () => {
  expect(kinds('mail jane.doe@gmail.com now')).toEqual(['email:j***@gmail.com'])
  expect(kinds('IBAN FR76 3000 6000 0112 3456 7890 189')).toEqual(['iban:FR76 **** **** **** **** ***0 189'])
  expect(kinds('IBAN FR76 3000 6000 0112 3456 7890 188')).toEqual([])
  expect(kinds('card 4111 1111 1111 1111')).toEqual(['card:**** **** **** 1111'])
  expect(kinds('card 4111 1111 1111 1112')).toEqual([])
  expect(kinds('NIR 1 85 05 78 006 084 91')).toEqual(['nir:1 ** ** ** *** *** 91'])
  expect(kinds('NIR 1 85 05 78 006 084 92')).toEqual([])
  expect(kinds('SSN 123-45-6789, not 000-12-3456')).toEqual(['ssn:***-**-6789'])
  expect(kinds('logo@2x.png, timestamp 1760270520000')).toEqual([])
})

test('finds French phone numbers in national form', () => {
  expect(kinds('tel 06 12 34 56 78')).toEqual(['phone:** ** ** ** 78'])
  expect(kinds('tel 01.45.67.89.12 or 0745678912')).toEqual(['phone:**.**.**.**.12', 'phone:********12'])
  expect(detect('06 12 34 56 78, 06.12.34.56.78 and +33 6 12 34 56 78')).toHaveLength(1)
  expect(kinds('0123456789, 0000000000, 06 12 34 56 78 90, v1.0612345678, 00612345678')).toEqual([])
})

test('finds phone numbers in international form', () => {
  expect(kinds('call +1 415 555 0132')).toEqual(['phone:+* *** *** **32'])
  expect(kinds('tel +33 6 12 34 56 78')).toEqual(['phone:+** * ** ** ** 78'])
  expect(kinds('tel 0033 (0)6 12 34 56 78')).toEqual(['phone:**** (*)* ** ** ** 78'])
  expect(kinds('office +44 20 7946 0958')).toEqual(['phone:+** ** **** **58'])
  expect(detect('+33 6 12 34 56 78 and 0033612345678')).toHaveLength(1)
  expect(kinds('id 0012345, tz +02:00, x+12345678, +33 6 12 34 5')).toEqual([])
  expect(kinds('+1 015 555 0132 has no valid area code')).toEqual([])
})

test('finds EU national identifiers with a valid check', () => {
  expect(kinds('NN 85.07.30-033.28')).toEqual(['be-nrn:**.**.**-***.28'])
  expect(kinds('NN 85.07.30-033.29')).toEqual([])
  expect(kinds('DNI 12345678Z, NIE X1234567L')).toEqual(['es-dni:********Z', 'es-dni:********L'])
  expect(kinds('DNI 12345678A')).toEqual([])
  expect(kinds('CF RSSMRA85T10A562S, lower rssmra85t10a562s')).toEqual(['it-cf:***************S'])
  expect(kinds('CF RSSMRA85T10A562T')).toEqual([])
})

test('finds secrets', () => {
  const gh = `ghp_${'a1B2'.repeat(9)}`
  expect(kinds(`aws AKIAIOSFODNN7EXAMPLE, token ${gh}`)).toEqual(['api-key:AKIA****MPLE', 'api-key:ghp_****a1B2'])
  expect(kinds(`key sk-ant-api03-${'x'.repeat(40)}`)).toEqual(['api-key:sk-a****xxxx'])
  expect(kinds('task-runner sk-short ghp_tooShort')).toEqual([])
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  expect(kinds(`Authorization: Bearer ${jwt}`)).toEqual(['jwt:eyJ**** (92 chars)'])
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n+abc/def==\n-----END RSA PRIVATE KEY-----'
  expect(kinds(`key:\n${pem}\nafter`)).toEqual(['private-key:-----BEGIN RSA PRIVATE KEY-----'])
  expect(redact(`a ${pem} b`, spansOf(`a ${pem} b`))).toBe('a [redacted:private-key] b')
})

test('redacts the password of a URL, not the user or host', () => {
  const url = 'DATABASE_URL=postgres://app:s3cretPw@db.internal:5432/main'
  expect(kinds(url)).toEqual(['url-password:postgres://app:***@db.internal:5432'])
  expect(redact(url, spansOf(url))).toBe('DATABASE_URL=postgres://app:[redacted:url-password]@db.internal:5432/main')
  expect(kinds('https://user:${PASS}@host https://u:password@host https://u:***@host')).toEqual([])
})

test('ignores values and leaves health terms and names alone', () => {
  expect(detect('jane@example.com', matcher(['*example.com']))).toEqual([])
  expect(kinds('Patient Jean Dupont, diabetes, born on 12/03/1984')).toEqual([])
})

test('records a tool result under its project and source', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/workspaces/clinic/data/patients.csv', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'name,email,key\nJane,jane.doe@gmail.com,AKIAIOSFODNN7EXAMPLE'))
  await settle()

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('j***@gmail.com')
  expect(toasts[0]).toContain('Read data/patients.csv')
  expect(toasts[0]).not.toContain('jane.doe')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'summary' })).toMatchObject({ text: expect.stringMatching(/clinic.*1 private, 1 secret, 2 occurrences/) })
  const email = await ui.find({ text: /j\*\*\*@gmail\.com/ })
  expect(email).toBeDefined()
  expect(await ui.find({ text: /Read by a tool: Read data\/patients\.csv/ })).toBeDefined()
})

test('notifies once per session, counts every occurrence', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('my phone is +33 6 12 34 56 78'))
  await settle()
  await $.session.append(prompt('again: +33.6.12.34.56.78'))
  await settle()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Sent by you')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /x2/ })).toBeDefined()
    await ui.press({ key: 'tab-timeline' })
    expect(await ui.find({ text: /today 14:02/ })).toBeDefined()
    await ui.press({ key: 'filter-secret' })
    expect(await ui.find({ text: /No secrets/ })).toBeDefined()
    await ui.press({ key: 'filter-all' })
    await ui.press({ key: 'tab-findings' })
    await ui.unmount()
  }
})

test('clears a project after confirmation', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('key AKIAIOSFODNN7EXAMPLE'))
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-confirm' })
  expect(await ui.find({ text: /Nothing seen yet/ })).toBeDefined()
})

test('skips notices the model never reads', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.session.append({
    door: 'notice',
    origin: { kind: 'engine' },
    uuid: 'row-notice',
    message: { type: 'system', content: [{ type: 'text', text: 'jane.doe@gmail.com' }] },
  })
  await settle()
  expect(toasts).toHaveLength(0)
})

test('stores findings after the row, not while it is appended', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('jane.doe@gmail.com'))
  await $.session.append(prompt('IBAN FR76 3000 6000 0112 3456 7890 189'))
  expect(toasts).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Nothing seen yet/ })).toBeDefined()
  await settle()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/email j\*\*\*@gmail\.com, iban FR76/)
  expect(await ui.find({ key: 'summary' })).toMatchObject({ text: expect.stringMatching(/2 private, 0 secret, 2 occurrences/) })
})

test('writes what is waiting when the session ends', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  session(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await $.session.append(prompt('key AKIAIOSFODNN7EXAMPLE'))
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'summary' })).toMatchObject({ text: expect.stringMatching(/0 private, 1 secret/) })
})

test('redact mode replaces values before the model reads them', { options: { mode: 'redact' } }, async ($, on) => {
  mock.store(on)
  const { toasts, rows, settle } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/workspaces/clinic/data/patients.csv', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'Jane,jane.doe@gmail.com,AKIAIOSFODNN7EXAMPLE'))
  await $.session.append(prompt('call me on +33 6 12 34 56 78'))
  await $.session.append(reply('Noted, jane.doe@gmail.com'))
  await settle()

  expect(keptText(rows, 'row-tu1')).toContain('Jane,[redacted:email],[redacted:api-key]')
  expect(keptText(rows, 'row-tu1')).not.toContain('jane.doe')
  expect(keptText(rows, 'row-prompt')).toContain('call me on [redacted:phone]')
  expect(keptText(rows, 'row-reply')).toContain('jane.doe@gmail.com')
  expect(toasts[0]).toMatch(/^Sensitive data redacted/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Mode here: redact, default/ })).toBeDefined()
  expect(await ui.find({ text: /Read data\/patients\.csv, redacted/ })).toBeDefined()
})

test('redact is the default mode', async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('call me on +33 6 12 34 56 78'))
  expect(keptText(rows, 'row-prompt')).toContain('call me on [redacted:phone]')
})

test('redact mode refuses to write placeholders back', { options: { mode: 'redact' } }, async ($, on) => {
  mock.store(on)
  session(on)
  await $.session.start(START)
  const written = await $.tool.call({ tool: 'Write', file_path: 'a.csv', content: 'Jane,[redacted:email]', tool_use_id: 'tu2' })
  expect(written).toMatchObject({ deny: expect.stringContaining('placeholders') })
  const read = await $.tool.call({ tool: 'Read', file_path: 'a.csv', tool_use_id: 'tu3' })
  expect(read).not.toHaveProperty('deny')
})

test('block mode withholds tool results and refuses prompts', { options: { mode: 'block' } }, async ($, on) => {
  mock.store(on)
  const { toasts, rows, settle } = session(on)
  const fills: string[] = []
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('prompt.fill', ($, e) => (fills.push(e.text), { isFilled: true }))
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/workspaces/clinic/data/patients.csv', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'Jane,jane.doe@gmail.com,AKIAIOSFODNN7EXAMPLE'))

  const kept = keptText(rows, 'row-tu1')
  expect(kept).toContain('Withheld by the leaks mod')
  expect(kept).toContain('email, api key')
  expect(kept).not.toContain('Jane')

  const sent = await $.prompt.submit({ text: 'my card is 4111 1111 1111 1111', wait: false, origin: { kind: 'composer' } })
  expect(sent).toMatchObject({ drop: expect.stringContaining('card number') })
  expect(await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })).toMatchObject({ text: 'hello' })
  await settle()
  expect(toasts[0]).toMatch(/^Sensitive data blocked/)
  expect(fills).toEqual(['my card is 4111 1111 1111 1111'])
})


test('side model calls get the same treatment as rows', () => {
  const piece = { text: 'summarize: jane.doe@gmail.com', via: 'side-call' as const, source: 'complete' }
  const base = { skip: () => false }
  expect(guard({ ...base, mode: 'notify' }, piece, true)).toMatchObject({ text: piece.text })
  expect(guard({ ...base, mode: 'redact' }, piece, true)).toMatchObject({ text: 'summarize: [redacted:email]' })
  expect(guard({ ...base, mode: 'block' }, piece, true).text).toContain('Withheld by the leaks mod')
  expect(guard({ ...base, mode: 'redact' }, piece, false)).toMatchObject({ text: piece.text })
})

test('sources keep the file or host, never commands or full URLs', () => {
  const root = '/home/me/workspaces/clinic'
  expect(describeTool('Read', { file_path: '/home/me/workspaces/clinic/data/patients.csv' }, root)).toBe('Read data/patients.csv')
  expect(describeTool('Bash', { command: 'curl -H "Authorization: Bearer abc123" https://api.example.org' }, root)).toBe('Bash')
  expect(describeTool('WebFetch', { url: 'https://user:pw@api.example.org/v1?token=abc123' }, root)).toBe('WebFetch api.example.org')
  expect(describeTool('Grep', { pattern: 'jane.doe' }, root)).toBe('Grep')
})

test('scans stay linear on hostile input', () => {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const unbroken = Array.from({ length: 200_000 }, (_, i) => alpha[(i * 7919) % 62]).join('')
  const csv = Array.from({ length: 5000 }, (_, i) => `user${i},user${i}@mail${i % 50}.com,+33 6 12 34 ${String(i % 100).padStart(2, '0')} 78\n`).join('')
  let t = performance.now()
  expect(spansOf(unbroken)).toHaveLength(0)
  expect(performance.now() - t).toBeLessThan(100)
  t = performance.now()
  expect(spansOf(csv)).toHaveLength(10000)
  expect(performance.now() - t).toBeLessThan(500)
})

test('stored ids depend on the install secret', () => {
  const key = 'email:jane.doe@gmail.com'
  const a = idFor('a'.repeat(64), key)
  expect(a).toMatch(/^[0-9a-f]{24}$/)
  expect(a).not.toBe(fnv1a(key))
  expect(idFor('a'.repeat(64), key)).toBe(a)
  expect(idFor('b'.repeat(64), 'email:other@gmail.com')).not.toBe(a)
})

test('a failed scan withholds every text the model would read', () => {
  const row = withheldRow({
    type: 'user',
    role: 'user',
    content: [
      { type: 'text', text: 'jane.doe@gmail.com' },
      { type: 'tool_result', tool_use_id: 'tu1', content: 'jane.doe@gmail.com' },
      { type: 'image', source: {} },
    ],
  })
  const text = JSON.stringify(row.content)
  expect(text).not.toContain('jane.doe')
  expect(text).toContain('could not be scanned')
  expect(row.content[2]).toEqual({ type: 'image', source: {} })
})

test('redacts each text part of a tool result once, keeping images', { options: { mode: 'redact' } }, async ($, on) => {
  mock.store(on)
  const { rows, settle } = session(on)
  await $.session.start(START)
  await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: 'row-parts',
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu9',
          content: [
            { type: 'text', text: 'mail jane.doe@gmail.com' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'nothing here' },
          ],
        },
      ],
    },
  })
  await settle()
  const kept = rows.appended().find(r => r.uuid === 'row-parts')?.message.content[0] as unknown as { content: { type: string; text?: string }[] }
  expect(kept.content.map(c => c.type)).toEqual(['text', 'image', 'text'])
  expect(kept.content[0]?.text).toBe(`mail ${placeholder('email')}`)
  expect(kept.content[2]?.text).toBe('nothing here')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /x1/ })).toBeDefined()
})

test('keeps full values only for personal identifiers, never secrets', { options: { mode: 'notify', storeRawValues: true } }, async ($, on) => {
  mock.store(on)
  const { settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('jane.doe@gmail.com AKIAIOSFODNN7EXAMPLE'))
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /jane\.doe@gmail\.com/ })).toBeDefined()
  expect(await ui.find({ text: /AKIA\*\*\*\*MPLE/ })).toBeDefined()
  expect(await ui.find({ text: /AKIAIOSFODNN7EXAMPLE/ })).toBeUndefined()
})

// The engine's /config rows for this mod, as a store the mod writes through `$.config.set`
const config = (on: On, values: Record<string, string>) => {
  on('config.list', () => ({
    value: Object.entries(values).map(([key, value]) => ({
      key,
      label: key,
      kind: 'text' as const,
      value,
      provider: { plugin: 'leaks@somelife-claude-mods', tier: 'user' as never },
      isLocked: false,
    })),
  }))
  on('config.set', ($, e) => ((values[e.key] = String(e.value)), { value: e.value }))
  return values
}

const HOME = '/home/me'

const COMMAND = { command: 'some-leaks', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

test('reads rules per folder', () => {
  const rules = parseRules('~/clients=block, ~/clients/acme/=off, /srv/data = redact, relative=block, ~/x=loud, nonsense', HOME)
  expect(rules).toEqual([
    { path: '/home/me/clients', mode: 'block' },
    { path: '/home/me/clients/acme', mode: 'off' },
    { path: '/srv/data', mode: 'redact' },
  ])
  expect(ruleFor(rules, '/home/me/clients/acme/src/a.ts')?.mode).toBe('off')
  expect(ruleFor(rules, '/home/me/clients/other')?.mode).toBe('block')
  expect(ruleFor(rules, '/home/me/clientsX')).toBeNull()
  expect(formatRules(withRule(rules, '/home/me/clients', null), HOME)).toBe('~/clients/acme=off, /srv/data=redact')
  expect(formatRules(withRule(rules, '/srv/data', 'notify'), HOME)).toBe('~/clients=block, ~/clients/acme=off, /srv/data=notify')
  expect(absolute('./data/a.csv', '/home/me/p')).toBe('/home/me/p/data/a.csv')
  expect(stricter('off', 'notify')).toBe('notify')
  expect(stricter('block', 'redact')).toBe('block')
})

test('a folder rule sets the session mode', { options: { mode: 'redact', rules: '~/workspaces/clinic=off' } }, async ($, on) => {
  mock.store(on)
  const { toasts, rows, settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('call me on +33 6 12 34 56 78'))
  await settle()
  expect(keptText(rows, 'row-prompt')).toContain('+33 6 12 34 56 78')
  expect(toasts).toHaveLength(0)
})

test('a file read takes the stricter of the two modes', { options: { mode: 'notify', rules: '~/workspaces/clinic/data=block' } }, async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/workspaces/clinic/data/clients.csv', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'jane.doe@gmail.com'))
  await $.tool.call({ tool: 'Read', file_path: 'README.md', tool_use_id: 'tu2' })
  await $.session.append(toolResult('tu2', 'jane.doe@gmail.com'))
  expect(keptText(rows, 'row-tu1')).toContain('Withheld by the leaks mod')
  expect(keptText(rows, 'row-tu2')).toContain('jane.doe@gmail.com')
})

test('a session rule is not weakened by a file rule', { options: { mode: 'notify', rules: '~/workspaces/clinic=block, /tmp=off' } }, async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/dump.txt', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'jane.doe@gmail.com'))
  expect(keptText(rows, 'row-tu1')).toContain('Withheld by the leaks mod')
})

test('the pane sets the mode of the project and the default', async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  const values = config(on, { 'leaks@somelife-claude-mods.mode': 'redact', 'leaks@somelife-claude-mods.rules': '' })
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-rules' })
  expect(await ui.find({ text: /No rules/ })).toBeDefined()

  await ui.press({ key: 'here-block' })
  expect(values['leaks@somelife-claude-mods.rules']).toBe('~/workspaces/clinic=block')
  expect(await ui.find({ text: /~\/workspaces\/clinic = block/ })).toBeDefined()
  await $.session.append(prompt('mail jane.doe@gmail.com'))
  expect(keptText(rows, 'row-prompt')).toContain('Withheld by the leaks mod')

  await ui.press({ key: 'default-notify' })
  expect(values['leaks@somelife-claude-mods.mode']).toBe('notify')
  await ui.press({ key: 'rule-remove-0' })
  expect(values['leaks@somelife-claude-mods.rules']).toBe('')
  expect(await ui.find({ text: /Mode here: notify, default/ })).toBeDefined()
})

test('the command sets the mode of the project and the default', { options: { rules: '/srv=off' } }, async ($, on) => {
  mock.store(on)
  session(on)
  const values = config(on, { 'leaks.mode': 'redact', 'leaks.rules': '/srv=off' })
  await $.session.start(START)
  expect(await $.command.run({ ...COMMAND, args: 'mode block' })).toMatchObject({ text: expect.stringContaining('~/workspaces/clinic now uses the block mode') })
  expect(values['leaks.rules']).toBe('/srv=off, ~/workspaces/clinic=block')
  expect(await $.command.run({ ...COMMAND, args: 'default off' })).toMatchObject({ text: 'Default mode is now off.' })
  expect(values['leaks.mode']).toBe('off')
  expect(await $.command.run({ ...COMMAND, args: 'mode loud' })).toMatchObject({ text: expect.stringContaining('Usage') })
})

test('a change made in /config applies at once', async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  config(on, { 'leaks.mode': 'redact', 'leaks.rules': '' })
  await $.session.start(START)
  await $.config.set({
    key: 'leaks.mode',
    value: 'off',
    previous: 'redact',
    provider: { plugin: 'leaks', tier: 'user' as never },
    origin: { kind: 'composer' },
  })
  await $.session.append(prompt('mail jane.doe@gmail.com'))
  expect(keptText(rows, 'row-prompt')).toContain('jane.doe@gmail.com')
})

test('with no /config row, the pane keeps its changes in the store', async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  config(on, {})
  await $.session.start(START)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-rules' })
  await ui.press({ key: 'here-block' })
  expect(await ui.find({ text: /Not changed/ })).toBeUndefined()
  expect(await ui.find({ text: /~\/workspaces\/clinic = block/ })).toBeDefined()
  await $.session.append(prompt('mail jane.doe@gmail.com'))
  expect(keptText(rows, 'row-prompt')).toContain('Withheld by the leaks mod')
  await ui.press({ key: 'rule-remove-0' })
  await ui.press({ key: 'default-off' })
  expect(await ui.find({ text: /Mode here: off, default/ })).toBeDefined()
})

test('a change kept in the store applies unless /config changed since', { options: { mode: 'redact', rules: '' } }, async ($, on) => {
  mock.store(on, {
    settings: {
      mode: { value: 'off', base: 'redact' },
      rules: { value: '~/workspaces/clinic=block', base: '/srv=off' },
    },
  })
  const { rows } = session(on)
  config(on, {})
  await $.session.start(START)
  await $.session.append(prompt('mail jane.doe@gmail.com'))
  expect(keptText(rows, 'row-prompt')).toContain('jane.doe@gmail.com')
})

test('the --global flag is read anywhere in the command', async ($, on) => {
  mock.store(on)
  session(on)
  const values = config(on, { 'leaks.ignore': '', 'leaks.folderIgnore': '' })
  await $.session.start(START)
  await $.command.run({ ...COMMAND, args: 'ignore *@corp.io --global' })
  expect(values['leaks.ignore']).toMatch(/,\*@corp\.io$/)
})

test('ignore entries match whole values, with * for any characters', () => {
  const skip = matcher(parsePatterns('dev@acme.com, *@corp.io, example.com, noreply', ','))
  expect(skip('dev@acme.com')).toBe(true)
  expect(skip('DEV@ACME.COM')).toBe(true)
  expect(skip('mydev@acme.com')).toBe(false)
  expect(skip('anyone@corp.io')).toBe(true)
  expect(skip('jane@sub.example.com')).toBe(true)
  expect(skip('github-noreply@users.github.com')).toBe(true)
  expect(skip('jane@gmail.com')).toBe(false)
  expect(matcher(['a.b'])('aXb')).toBe(false)
})

test('reads ignore lists per folder', () => {
  const list = parseFolderIgnores('~/clients/acme=*@acme.com|noreply@*, /srv=x@y.z, broken, ~/empty=', HOME)
  expect(list).toEqual([
    { path: '/home/me/clients/acme', patterns: ['*@acme.com', 'noreply@*'] },
    { path: '/srv', patterns: ['x@y.z'] },
  ])
  expect(patternsFor(['g@g.com'], list, ['/home/me/clients/acme/src'])).toEqual(['g@g.com', '*@acme.com', 'noreply@*'])
  expect(patternsFor([], list, ['/home/me/clients/other'])).toEqual([])
  expect(formatFolderIgnores(withIgnore(list, '/srv', 'x@y.z', false), HOME)).toBe('~/clients/acme=*@acme.com|noreply@*')
  expect(formatFolderIgnores(withIgnore(list, '/home/me/p', 'a@b.c', true), HOME)).toBe(
    '~/clients/acme=*@acme.com|noreply@*, /srv=x@y.z, ~/p=a@b.c',
  )
})

test('an ignore list applies to its folder only', { options: { mode: 'notify', folderIgnore: '/tmp/dumps=*@gmail.com' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/dumps/a.txt', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'jane.doe@gmail.com'))
  await settle()
  expect(toasts).toHaveLength(0)
  await $.session.append(prompt('jane.doe@gmail.com'))
  await settle()
  expect(toasts).toHaveLength(1)
})

test('former ignore entries keep matching as before', { options: { mode: 'notify', ignore: 'example.com,noreply' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('jane@example.com, noreply@github.com, jane.doe@gmail.com'))
  await settle()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('j***@gmail.com')
  expect(toasts[0]).not.toContain('example.com')
})

test('a finding of this session can be ignored from the pane', { options: { mode: 'notify', ignore: '' } }, async ($, on) => {
  mock.store(on)
  const { settle } = session(on)
  const values = config(on, { 'leaks.ignore': '', 'leaks.folderIgnore': '' })
  await $.session.start(START)
  await $.session.append(prompt('mail jane.doe@gmail.com'))
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const here = (await ui.find({ type: 'Button', text: 'Ignore here' }))?.key ?? ''
  const all = (await ui.find({ type: 'Button', text: 'Ignore everywhere' }))?.key ?? ''
  await ui.press({ key: here })
  expect(values['leaks.folderIgnore']).toBe('~/workspaces/clinic=jane.doe@gmail.com')
  await ui.press({ key: all })
  expect(values['leaks.ignore']).toBe('jane.doe@gmail.com')
  await ui.press({ key: 'tab-rules' })
  expect(await ui.find({ text: /~\/workspaces\/clinic: jane\.doe@gmail\.com/ })).toBeDefined()
  await ui.press({ key: 'ignore-global-remove-0' })
  expect(values['leaks.ignore']).toBe('')
  await ui.press({ key: 'ignore-folder-remove-0-0' })
  expect(values['leaks.folderIgnore']).toBe('')
})

test('the command manages both ignore lists', { options: { ignore: '' } }, async ($, on) => {
  mock.store(on)
  session(on)
  const values = config(on, { 'leaks.ignore': '', 'leaks.folderIgnore': '' })
  await $.session.start(START)
  expect(await $.command.run({ ...COMMAND, args: 'ignore *@acme.com' })).toMatchObject({ text: '*@acme.com is now ignored in ~/workspaces/clinic.' })
  expect(values['leaks.folderIgnore']).toBe('~/workspaces/clinic=*@acme.com')
  expect(await $.command.run({ ...COMMAND, args: 'ignore --global *@corp.io' })).toMatchObject({ text: '*@corp.io is now ignored everywhere.' })
  expect(values['leaks.ignore']).toBe('*@corp.io')
  await $.command.run({ ...COMMAND, args: 'unignore *@acme.com' })
  expect(values['leaks.folderIgnore']).toBe('')
  expect(await $.command.run({ ...COMMAND, args: 'ignore a,b' })).toMatchObject({ text: expect.stringContaining('Not changed') })
})
