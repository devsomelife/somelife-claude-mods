# Somelife Claude Code Mods

A library of Claude Code mods. Each mod is a standalone plugin: install only the ones you want.

Mods work in the Claude Code CLI and in the Claude desktop app (Code tab).

## Catalog

| Mod | Category | Summary | Changes Claude's behaviour |
| --- | --- | --- | --- |
| [greve-generale](plugins/greve-generale/README.md) | fun | Tools randomly go on strike for absurd French reasons | Yes, refuses some tool calls |
| [workload](plugins/workload/README.md) | productivity | Daily load per project across all sessions, charted in a pane | No, display only |

## Installation

Add the marketplace once:

```bash
/plugin marketplace add devsomelife/somelife-claude-mods
```

Then install the mods you want:

```bash
/plugin install greve-generale@somelife-claude-mods
```

```bash
/plugin install workload@somelife-claude-mods
```

- Update: `/plugin marketplace update somelife-claude-mods`
- Disable or remove: `/plugin`, then pick the mod

## Repository Layout

```
.claude-plugin/
  marketplace.json        catalog of every mod
plugins/
  <mod-name>/
    .claude-plugin/
      plugin.json         manifest: name, version, description, settings
    hooks/
      hooks.json          points to the hooks module
      register.ts         the mod itself
      <mod-name>.test.ts  tests
    tsconfig.json
    README.md             what the mod does, settings
docs/
  creating-a-mod.md       how to add a mod to this library
```

## Security

- Mods are not sandboxed: they run with the same access as Claude Code
- Read a mod's `hooks/register.ts` before installing it
- Every mod in this library must list in its README what it changes

## Contributing

See [docs/creating-a-mod.md](docs/creating-a-mod.md).
