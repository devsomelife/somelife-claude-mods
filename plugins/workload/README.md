# workload

Tracks how much Claude works on each of your projects, across every session, and charts the load of a day, a week or 30 days in a pane.

## Behaviour

- Global: every session with the mod installed writes to the same history, whatever the project
- A project is the git repository's root folder name (worktrees count as their main repository), or the session folder's name outside git
- Recorded at the end of each turn, per project and per day:
  - Active time: how long Claude worked on the turn, split by hour of the day
  - Turns, tokens (input, output and cache, subagents included), tool calls, sessions
- `/workload` opens the pane

**Changes Claude's behaviour:** no. It only records and displays.

## Install

From a Claude Code prompt:

```text
/plugin marketplace add devsomelife/somelife-claude-mods
/plugin install workload@somelife-claude-mods
```

From a shell:

```bash
claude plugin marketplace add devsomelife/somelife-claude-mods
```

```bash
claude plugin install workload@somelife-claude-mods
```

- Loads in every new session, in every project
- Skip the `marketplace add` step if the marketplace is already added

## Update

```bash
claude plugin marketplace update somelife-claude-mods
```

```bash
claude plugin update workload@somelife-claude-mods
```

- Restart Claude Code to load the new version

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `retentionDays` | number | `120` | Days of history kept; older days are deleted when a session starts |

Change it, then restart Claude Code:

```text
/plugin configure workload@somelife-claude-mods
```

```bash
echo '{"retentionDays":"365"}' | claude plugin configure workload@somelife-claude-mods --values-stdin
```

- `claude plugin configure workload@somelife-claude-mods` lists the settings and which ones are set
- Values are saved in `~/.claude/settings.json`, under `pluginConfigs`

## Pane

Three modes, picked from the tab row at the top: **Daily split**, **Weekly split**, **30-day split**. The mode's title and period sit under the tabs, then one framed section per block:

| Section | Daily split | Weekly and 30-day split |
| --- | --- | --- |
| Summary | Active time, turns, tokens, tool calls, sessions, projects, first, last and peak hour | Same, over the period |
| Share by project | One bar per project, value and percentage for the chosen metric | Same |
| Chart | Active time by hour, one stacked column per hour | Chosen metric by day, one stacked column per day |
| Stats by project | Time, share, turns, tokens, tool calls, sessions, peak hour; hover a column name for its meaning | Same |

- Desktop app: SVG charts with hover tooltips, following the light or dark theme
- Terminal: text bars, an hour-by-project heatmap and the same stats table
- Each project keeps its color everywhere, from the first time it is recorded; past 8 projects, the extra ones share a gray

Controls (hotkeys work once the pane has focus):

| Control | Hotkey |
| --- | --- |
| Previous day or week, back to the current one | `h` / `t` |
| Next day or week, shown only on a past period | `l` |
| Daily, weekly, 30-day split | `d` / `w` / `m` |
| Metric: time, tokens, turns, tools | `1` / `2` / `3` / `4` |
| Show one project only | project picker |
| Back to all projects | "All projects" in the picker |

## Data

- Stored in the mod's own store under the Claude Code configuration directory, one entry per day
- Nothing leaves your machine
- Two sessions finishing a turn at the exact same moment can lose one of the two writes; the error is one turn at most
- Hours are in the local time of the machine

## Uninstall

```bash
claude plugin uninstall workload@somelife-claude-mods
```

- To pause it instead: `claude plugin disable workload@somelife-claude-mods`, then `enable` to resume
