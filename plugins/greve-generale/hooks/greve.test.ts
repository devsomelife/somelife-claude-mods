import { expect, test } from 'claude-code/testing'

test('toujours en grève à 100%', { options: { chance: 100 } }, async ($, on) => {
  on('tool.call', () => ({ result: { text: 'travail effectué' } }))
  const r = await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  expect(r.deny ?? '').toContain('grève')
})

test('jamais en grève à 0%', { options: { chance: 0 } }, async ($, on) => {
  on('tool.call', () => ({ result: { text: 'travail effectué' } }))
  const r = await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  expect(r.deny).toBe(undefined)
})
