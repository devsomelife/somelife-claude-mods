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

## Pane

| Section | Content |
| --- | --- |
| Summary | Active time, turns, tokens, tool calls, sessions, projects, first and last active hour, peak hour |
| Share by project | One bar per project, value and percentage for the chosen metric |
| Active time by hour | One row per project, one cell per hour, shaded by active time, plus an overall sparkline |
| Load by day | Week and 30 days views: one stacked bar per day, one color per project |
| Stats by project | Time, share, turns, tokens, tool calls, sessions, peak hour |

Controls (hotkeys work once the pane has focus):

| Control | Hotkey |
| --- | --- |
| Previous / next period, back to today | `h` / `l` / `t` |
| Day, week, 30 days | `d` / `w` / `m` |
| Metric: time, tokens, turns, tools | `1` / `2` / `3` / `4` |
| Show one project only | click its name in "Share by project" |
| Back to all projects | `a` |

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `retentionDays` | number | `120` | Days of history kept; older days are deleted when a session starts |

## Data

- Stored in the mod's own store under the Claude Code configuration directory, one entry per day
- Nothing leaves your machine
- Two sessions finishing a turn at the exact same moment can lose one of the two writes; the error is one turn at most
- Hours are in the local time of the machine
