import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { dayKey, fmtDuration, slices } from './register'

// 2026-10-06 at 10:30 local time
const NOW = new Date(2026, 9, 6, 10, 30).getTime()
const TODAY = 'day:2026-10-06'

const PANE = {
  plugin: 'workload',
  component: 'Pane',
  requestId: 'workload',
  props: {
    title: 'Workload',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const session = (on: On, root: string) => {
  mock.clock(on, { now: NOW })
  on('session.repo', () => ({ value: null }))
  on('session.root', () => ({ value: root }))
  on('session.id', () => ({ value: 'session-1' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
}

const turn = (durationMs: number) => ({
  answer: 'done',
  durationMs,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  usage: {
    model: 'claude-opus-5-5',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 50,
  },
})

test('splits a turn across hours', async () => {
  const parts = slices(new Date(2026, 9, 6, 9, 45).getTime(), NOW)
  expect(parts.map(p => [p.day, p.hour, p.ms / 60_000])).toEqual([
    ['2026-10-06', 9, 15],
    ['2026-10-06', 10, 30],
  ])
  expect(dayKey(NOW)).toBe('2026-10-06')
  expect(fmtDuration(45 * 60_000)).toBe('45m')
  expect(fmtDuration(125 * 60_000)).toBe('2h05')
})

test('records a turn under its project', async ($, on) => {
  mock.store(on)
  session(on, '/home/me/workspaces/alpha')
  await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  await $.tool.call({ tool: 'Read', file_path: 'b.md' })
  await $.turn.complete(turn(45 * 60_000))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Active 45m \| 1 turns \| 1\.0k tokens \| 2 tools \| 1 sessions \| 1 projects/ })).toBeDefined()
  expect(await ui.find({ text: /First 09h \| last 10h \| peak 10h/ })).toBeDefined()
  expect(await ui.find({ text: /alpha/ })).toBeDefined()
})

test('draws the pane on every surface', async ($, on) => {
  const hours = Array.from({ length: 24 }, (_, h) => (h === 9 ? 3_600_000 : 0))
  mock.store(on, {
    [TODAY]: {
      alpha: { activeMs: 3_600_000, turns: 4, tokens: 5000, tools: 20, sessions: ['s1'], hours },
      beta: { activeMs: 1_800_000, turns: 2, tokens: 1000, tools: 5, sessions: ['s2'], hours },
    },
  })
  session(on, '/home/me/workspaces/alpha')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Share by project/ })).toBeDefined()
    expect(await ui.find({ text: /Active 1h30/ })).toBeDefined()
    expect(await ui.find({ text: /67%/ })).toBeDefined()

    await ui.press({ key: 'range-week' })
    expect(await ui.find({ text: /Load by day/ })).toBeDefined()
    await ui.press({ key: 'range-day' })
    await ui.unmount()
  }
})

test('says so when nothing was recorded', async ($, on) => {
  mock.store(on)
  session(on, '/home/me/workspaces/alpha')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /No activity/ })).toBeDefined()
})
