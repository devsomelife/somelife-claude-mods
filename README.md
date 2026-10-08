# Somelife Claude Code Mods

A library of Claude Code mods. Each mod is a standalone plugin: install only the ones you want.

Mods work in the Claude Code CLI and in the Claude desktop app (Code tab).

## Catalog

| Mod | Category | Summary | Changes Claude's behaviour |
| --- | --- | --- | --- |
| [greve-generale](plugins/greve-generale/README.md) | fun | Tools randomly go on strike for absurd French reasons | Yes, refuses some tool calls |
| [workload](plugins/workload/README.md) | productivity | Daily load per project across all sessions, charted in a pane | No, display only |

## Installation

Each step works from a Claude Code prompt or from a shell.

Add the marketplace once:

```text
/plugin marketplace add devsomelife/somelife-claude-mods
```

```bash
claude plugin marketplace add devsomelife/somelife-claude-mods
```

Then install the mods you want:

```text
/plugin install greve-generale@somelife-claude-mods
/plugin install workload@somelife-claude-mods
```

```bash
claude plugin install workload@somelife-claude-mods
```

- Installed mods load in every new session, in every project
- Disable or remove: `/plugin`, then pick the mod

## Updates

Fetch the latest catalog, then update the mod:

```bash
claude plugin marketplace update somelife-claude-mods
```

```bash
claude plugin update workload@somelife-claude-mods
```

- From Claude Code: `/plugin marketplace update somelife-claude-mods`, then `/plugin` and pick the mod
- Restart Claude Code to load the new version

## Settings

Each mod lists its settings in its README. Change them without reinstalling:

```text
/plugin configure greve-generale@somelife-claude-mods
```

From a shell, pipe the new values as JSON, each value as a string:

```bash
echo '{"chance":"10"}' | claude plugin configure greve-generale@somelife-claude-mods --values-stdin
```

- `claude plugin configure <mod>@somelife-claude-mods` lists the settings and which ones are set
- Values are saved in `~/.claude/settings.json`, under `pluginConfigs`
- Restart Claude Code to apply them

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
