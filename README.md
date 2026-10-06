# Somelife Claude Code Mods

A library of Claude Code mods. Each mod is a standalone plugin: install only the ones you want.

Mods work in the Claude Code CLI and in the Claude desktop app (Code tab).

## Catalog

| Mod | Category | Summary | Changes Claude's behaviour |
| --- | --- | --- | --- |
| [greve-generale](plugins/greve-generale/README.md) | fun | Tools randomly go on strike for absurd French reasons | Yes, refuses some tool calls |

## Installation

### From the marketplace (recommended)

Add the marketplace once:

```bash
/plugin marketplace add devsomelife/somelife-claude-mods
```

Then install the mods you want:

```bash
/plugin install greve-generale@somelife-claude-mods
```

- Update: `/plugin marketplace update somelife-claude-mods`
- Disable or remove: `/plugin`, then pick the mod

### From a local clone

Load a mod for one terminal session:

```bash
claude --plugin-dir /path/to/somelife-claude-mods/plugins/greve-generale
```

Load mods in every session, desktop app included, through `env` in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/somelife-claude-mods/plugins/greve-generale"
  }
}
```

- Paths are separated by `:`
- Interactive sessions watch these folders: editing a mod reloads it live

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
