# Mod Creation Guide

## Mod Anatomy

- A mod is a plugin whose `hooks/hooks.json` names a TypeScript module
- The module exports `register(on, options)`
- `on(event, matcher?, hook)` attaches a hook to a Claude Code event
- Every hook has the shape `($, e, next)`:
  - `$`: the engine interface (`$.ui.toast`, `$.ui.status`, `$.fs`, `$.clock`, ...)
  - `e`: the event input
  - `next(e)`: continue to the other mods and the engine, returns the result
- Returning without calling `next` answers the event yourself, for example `{ deny: 'reason' }` on `tool.call`

Common events:

| Event | Use |
| --- | --- |
| `tool.call` | React to, rewrite or refuse a tool call |
| `prompt.submit` | React to or rewrite a user prompt |
| `prompt.compose` | Change the system prompt |
| `turn.complete` | Run something when Claude finishes a turn |
| `ui.render` | Draw panes, bands above the prompt, custom UI |
| `session.start` | Register slash commands, open panes |

## Steps

1. Create the folder `plugins/<mod-name>/` with:
   - `.claude-plugin/plugin.json`: `name`, `version`, `description`, `author`, optional `userConfig`
   - `hooks/hooks.json`: `{ "modules": ["./register.ts"] }`
   - `hooks/register.ts`
   - `hooks/<mod-name>.test.ts`
   - `tsconfig.json`: `{ "extends": "./.claude-plugin/types/tsconfig.json" }`
   - `README.md`: the mod's own mini doc, see [Mod README](#mod-readme)
2. Try it live:
   ```bash
   claude --plugin-dir plugins/<mod-name>
   ```
3. Validate and test:
   ```bash
   claude plugin validate plugins/<mod-name>
   ```
   ```bash
   claude plugin test plugins/<mod-name>
   ```
4. Add an entry to `.claude-plugin/marketplace.json`
5. Add a row to the catalog in the root `README.md`
6. Commit with a Conventional Commits message, for example `feat(<mod-name>): add mod`

## Mod README

Each mod's README is a standalone mini doc: a reader who lands on it needs nothing from the root README.

Sections, in this order:

| Section | Content |
| --- | --- |
| `# <mod-name>` and one line | What the mod does |
| Behaviour | What happens, and "Changes Claude's behaviour: yes/no" with the reason |
| Install | Marketplace add and install, from Claude Code and from a shell |
| Update | Marketplace update, plugin update, restart |
| Settings | Table of `userConfig` fields, then how to change them from Claude Code and from a shell |
| Mod-specific sections | Pane, controls, data, customisation, as the mod needs |
| Uninstall | Uninstall, and disable / enable to pause |

- Claude Code slash commands go in `text` blocks, shell commands in `bash` blocks, one command per block
- Copy the Install, Update and Uninstall sections from an existing mod and change the name

## Tests

- Tests import `test` and `expect` from `claude-code/testing`
- In a test, `on(...)` stands in for the engine beneath the mod
- A stubbed `tool.call` must answer `{ result: { text } }` or `{ deny }`
- Settings are passed with `test(name, { options: { ... } }, body)`

Example:

```ts
import { expect, test } from 'claude-code/testing'

test('lets every tool call through', async ($, on) => {
  on('tool.call', () => ({ result: { text: 'done' } }))
  const r = await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  expect(r.deny).toBe(undefined)
})
```

## Types

- Claude Code writes the API types into `.claude-plugin/types/` the first time the mod loads
- That folder is git-ignored
- Type-check with `tsc -p plugins/<mod-name>` once the mod has loaded

## Rules for This Library

- One mod per folder, self-contained
- Each README states whether the mod changes Claude's behaviour or only the display
- Settings that affect behaviour (probabilities, thresholds) go in `userConfig`, never hard-coded
- No mod hides what it does, bypasses permissions or sends data elsewhere
- Bump `version` in both `plugin.json` and `marketplace.json` on each change
