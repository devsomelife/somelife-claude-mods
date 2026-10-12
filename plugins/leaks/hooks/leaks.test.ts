import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionAppendInput } from 'claude-code'

import { detect } from './detect'
import { guard } from './register'

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

test('finds private data and masks it', () => {
  expect(kinds('mail jane.doe@gmail.com now')).toEqual(['email:j***@gmail.com'])
  expect(kinds('IBAN FR76 3000 6000 0112 3456 7890 189')).toEqual(['iban:FR76 **** **** **** **** ***0 189'])
  expect(kinds('IBAN FR76 3000 6000 0112 3456 7890 188')).toEqual([])
  expect(kinds('card 4111 1111 1111 1111')).toEqual(['card:**** **** **** 1111'])
  expect(kinds('card 4111 1111 1111 1112')).toEqual([])
  expect(kinds('NIR 1 85 05 78 006 084 91')).toEqual(['nir:1 ** ** ** *** *** 91'])
  expect(kinds('NIR 1 85 05 78 006 084 92')).toEqual([])
  expect(kinds('SSN 123-45-6789, not 000-12-3456')).toEqual(['ssn:***-**-6789'])
  expect(kinds('tel 06 12 34 56 78')).toEqual(['phone:** ** ** ** 78'])
  expect(kinds('call +1 415 555 0132')).toEqual(['phone:+* *** *** **32'])
  expect(kinds('date de naissance : 12/03/1984')).toEqual(['birthdate:**/**/1984'])
  expect(kinds('logo@2x.png, timestamp 1760270520000')).toEqual([])
})

test('finds medical terms, not lookalikes', () => {
  expect(kinds('Patient diagnosed with diabetes, HIV positive')).toEqual([
    'health:diagnosed with',
    'health:diabetes',
    'health:HIV',
  ])
  expect(kinds('Dossier médical: dépression, traitement Xanax')).toEqual([
    'health:dossier médical',
    'health:dépression',
    'health:xanax',
  ])
  expect(kinds('TypeScript diagnostics; this aids the reader; cancellation token')).toEqual([])
  expect(detect('jane@example.com', ['example.com'])).toEqual([])
})

test('records a tool result under its project and source', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/workspaces/clinic/data/patients.csv', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'name,email,condition\nJane,jane.doe@gmail.com,diabetes'))
  await settle()

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('j***@gmail.com')
  expect(toasts[0]).toContain('Read data/patients.csv')
  expect(toasts[0]).not.toContain('jane.doe')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'summary' })).toMatchObject({ text: expect.stringMatching(/clinic.*1 private, 1 medical, 2 occurrences/) })
  const email = await ui.find({ text: /j\*\*\*@gmail\.com/ })
  expect(email).toBeDefined()
  expect(await ui.find({ text: /Read by a tool: Read data\/patients\.csv/ })).toBeDefined()
})

test('notifies once per session, counts every occurrence', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { toasts, settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('my phone is 06 12 34 56 78'))
  await settle()
  await $.session.append(prompt('again: 06.12.34.56.78'))
  await settle()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Sent by you')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /x2/ })).toBeDefined()
    await ui.press({ key: 'tab-timeline' })
    expect(await ui.find({ text: /today 14:02/ })).toBeDefined()
    await ui.press({ key: 'filter-medical' })
    expect(await ui.find({ text: /No medical data/ })).toBeDefined()
    await ui.press({ key: 'filter-all' })
    await ui.press({ key: 'tab-findings' })
    await ui.unmount()
  }
})

test('clears a project after confirmation', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  const { settle } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('HIV test result'))
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
  expect(await ui.find({ key: 'summary' })).toMatchObject({ text: expect.stringMatching(/2 private, 0 medical, 2 occurrences/) })
})

test('writes what is waiting when the session ends', { options: { mode: 'notify' } }, async ($, on) => {
  mock.store(on)
  session(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start(START)
  await $.session.append(prompt('HIV test result'))
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'summary' })).toMatchObject({ text: expect.stringMatching(/0 private, 1 medical/) })
})

test('redact mode replaces values before the model reads them', { options: { mode: 'redact' } }, async ($, on) => {
  mock.store(on)
  const { toasts, rows, settle } = session(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/workspaces/clinic/data/patients.csv', tool_use_id: 'tu1' })
  await $.session.append(toolResult('tu1', 'Jane,jane.doe@gmail.com,diabetes'))
  await $.session.append(prompt('call me on 06 12 34 56 78'))
  await $.session.append(reply('Noted, jane.doe@gmail.com'))
  await settle()

  expect(keptText(rows, 'row-tu1')).toContain('Jane,[redacted:email],[redacted:health]')
  expect(keptText(rows, 'row-tu1')).not.toContain('jane.doe')
  expect(keptText(rows, 'row-prompt')).toContain('call me on [redacted:phone]')
  expect(keptText(rows, 'row-reply')).toContain('jane.doe@gmail.com')
  expect(toasts[0]).toMatch(/^Sensitive data redacted/)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Mode: redact/ })).toBeDefined()
  expect(await ui.find({ text: /Read data\/patients\.csv, redacted/ })).toBeDefined()
})

test('redact is the default mode', async ($, on) => {
  mock.store(on)
  const { rows } = session(on)
  await $.session.start(START)
  await $.session.append(prompt('call me on 06 12 34 56 78'))
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
  await $.session.append(toolResult('tu1', 'Jane,jane.doe@gmail.com,diabetes'))

  const kept = keptText(rows, 'row-tu1')
  expect(kept).toContain('Withheld by the leaks mod')
  expect(kept).toContain('email, health term')
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
  const base = { notify: 'toast', storeRaw: false, ignore: [] }
  expect(guard({ ...base, mode: 'notify' }, piece, true)).toMatchObject({ text: piece.text })
  expect(guard({ ...base, mode: 'redact' }, piece, true)).toMatchObject({ text: 'summarize: [redacted:email]' })
  expect(guard({ ...base, mode: 'block' }, piece, true).text).toContain('Withheld by the leaks mod')
  expect(guard({ ...base, mode: 'redact' }, piece, false)).toMatchObject({ text: piece.text })
})
