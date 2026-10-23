# leaks

Watches everything the model reads or writes for personal identifiers and secrets. By default each value is replaced by a placeholder before it leaves your machine; you get a notification, and each project keeps a list of what was found, when and through which source. Two other modes only record it, or withhold the whole content.

| | |
| --- | --- |
| Use | `/some-leaks` opens the pane; `/some-leaks mode block` sets this project's mode; `/some-leaks default redact` sets the default; `/some-leaks ignore <entry>` ignores a value |
| Watches | Your prompts, tool results, files and context added to the conversation, the model's replies and tool inputs, subagents, other mods' side model calls |
| Detects | Personal identifiers: emails, phone numbers, IBANs, card numbers, national ids (FR, BE, ES, IT, US). Secrets: API keys, private keys, passwords in URLs, JWTs |
| Notifies | Once per value and session, by toast, system notification, both or off |
| Modes | `redact` (default), `notify`, `block`, `off`; one per folder if you want |
| Changes Claude's behaviour | Yes by default: `redact` and `block` change what the model reads; `notify` changes nothing |
| Settings | `mode`, `rules`, `ignore`, `folderIgnore`, `failClosed`, `notify`, `storeRawValues`, `retentionDays` |

## Scope

- Only identifiers with a fixed format, most of them with a check digit: few false positives, no guessing
- Names, postal addresses, health data and free text are out of scope: no pattern detects them reliably
- Phone numbers are matched in international form (`+33 6 ...`, `0033 6 ...`) for every country, and in national form for France only (`06 12 34 56 78`): other countries' national numbers cannot be told apart from an id, an amount or a timestamp

## Behaviour

- Every row the conversation keeps is scanned before it is stored, and the API request is built from the row as stored
- Detection runs locally, inside Claude Code: no model, no remote service, no network call
- Each row is scanned once, when it is added; the history is never scanned again (see Performance)
- Only the scan runs in the conversation's path; findings are stored and notified 250 ms later, off that path, and anything still waiting is written when the session ends
- Rows the model never reads (notices) and compaction summaries are skipped
- A project is the git repository's root folder name, or the session folder's name outside git
- Each distinct value is one finding per project, with its count, first and last time, and its 20 latest occurrences
- A value seen again in the same session is counted, not notified again
- A status line keeps the number of sensitive items seen this session

**Changes Claude's behaviour:** yes by default. In `redact` (the default) and `block` modes the model reads placeholders or a withheld notice instead of the data, and some prompts and writes are refused. Every such change is notified and listed in the pane. In `notify` mode nothing is changed.

## Performance

- The cost follows what each turn adds, not the size of the context: a long session costs the same per turn as a fresh one
- Every pattern runs in linear time: hostile input cannot make a scan blow up
- Folders in `off` mode are not scanned at all

| Input | Scan time |
| --- | --- |
| 20 KB of code, a typical file read | 0.4 ms |
| 200 KB of code | 3.4 ms |
| 200 KB of unbroken letters or digits | 1 to 5 ms |
| 117 KB CSV holding about 6,000 emails and phones | 10 ms |
| Finding a folder's rule among 50 | under 0.01 ms |

| Kept in memory | Limit |
| --- | --- |
| Each tool call's source and mode | Dropped once its result is scanned |
| Values already notified this session | One short id per distinct value |
| Findings waiting to be stored | Emptied 250 ms later |

| Stored | Limit |
| --- | --- |
| Findings | 300 per project, the oldest dropped first |
| Occurrences | 20 per finding, deleted after `retentionDays` |

## Modes

| Mode | Prompts | Tool results and context | Side model calls | What reaches the API |
| --- | --- | --- | --- | --- |
| `redact` (default) | Values replaced by `[redacted:<kind>]` | Values replaced by `[redacted:<kind>]` | Values replaced | Placeholders only |
| `notify` | Sent as typed | Kept as read | Sent as written | Everything |
| `block` | Refused, put back in the prompt box with the values underlined | Whole content replaced by a withheld notice | Refused | A notice naming the kinds found |
| `off` | Not scanned | Not scanned | Not scanned | Everything, nothing recorded |

- The model's own replies and tool inputs are recorded, never rewritten: they come from the API, not from your machine
- In `redact` and `block` modes, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Bash` calls whose input holds a placeholder are refused, so the model cannot write placeholders back over the real values
- `redact` breaks tasks that need the real value, such as editing the lines of a file that hold it
- `block` stops Claude from working on files that hold such data at all
- For a password in a URL, only the password is replaced: `postgres://app:[redacted:url-password]@db.internal`

## Modes per Folder

The `mode` setting is the default. The `rules` setting gives other folders their own mode:

```
~/workspaces/clients/bvidf=block, ~/workspaces/perso=off, ~/workspaces/clients/bvidf/docs=notify
```

| Rule | Behaviour |
| --- | --- |
| Which rule applies | The deepest folder holding the path; no rule, the default mode |
| Prompts, replies, context, side model calls | The mode of the session's folder (the project root, as `/cd` and worktree moves change it) |
| A tool that names a file (`Read`, `Write`, `Edit`, ...) | The stricter of the session's mode and the file's own folder's |
| A tool without a file (`Bash`, `Grep`, `WebFetch`) | The session's mode |
| Strictness | `off` < `notify` < `redact` < `block` |

- A session in an `off` folder reading a file under a `block` folder withholds that file; a session in a `block` folder never relaxes for a file under an `off` folder
- Paths are absolute or start with `~`; a comma cannot appear in a path
- Rules live in your own settings only: a repository cannot change them

Three ways to change them, all writing the same settings:

```mermaid
flowchart LR
    Pane["Pane, Rules tab"] --> Rows{"/config lists the mod's rows"}
    Command["/some-leaks mode, /some-leaks default"] --> Rows
    Rows -->|yes| Settings["settings.json: mode, rules"]
    Rows -->|no| Store["Mod store: overrides"]
    Config["/config"] --> Settings
    Settings --> Mod["leaks mod, applied at once"]
    Store --> Mod
```

| Where | How |
| --- | --- |
| Pane, `Rules` tab (`r`) | Buttons for this project's mode (or back to the default), the default mode, and a list of rules to remove |
| Command | `/some-leaks mode <off\|notify\|redact\|block\|default>` for this project, `/some-leaks default <mode>` for the default |
| `/config` | The `Default mode` and `Modes per folder` rows |

- This project is the git repository's root folder, or the session's folder outside git
- Every change applies at once, no restart needed
- Some Claude Code builds list no plugin rows in `/config`: the pane and the command then keep the change in the mod's own store, in `~/.claude/plugins/store`
  - Each kept change remembers the settings value it was made over
  - A later change of that setting in `/config` or with `claude plugin configure` wins, and the kept change is dropped

## Ignore Lists

| List | Setting | Applies to |
| --- | --- | --- |
| Global | `ignore` | Everything |
| Per folder | `folderIgnore`, `folder=entry\|entry` items separated by commas | Content tied to that folder: the session's folder for prompts and replies, and also the file's folder for a file read |

```
ignore:       *example.com, git@github.com, dev@somelife.eu
folderIgnore: ~/workspaces/clients/acme=*@acme.com|noreply@*, ~/workspaces/perso=*@gmail.com
```

- An entry matches a whole value or source, ignoring case: `dev@acme.com` matches that address only, not `mydev@acme.com`
- `*` stands for any characters: `*@acme.com` ignores a whole domain, `*plugins/leaks/hooks*` every file under that folder
- A finding is skipped when its value or its source matches an entry of the global list or of a folder that holds the content
- Entries cannot hold `,` or `|`
- Entries written for the former "contains" matching (`example.com`, `noreply`, `plugins/leaks/hooks`) are read as their wildcard form

| Where | How |
| --- | --- |
| Pane, a finding of this session | "Ignore here" for this project, "Ignore everywhere" for the global list |
| Pane, `Rules` tab (`r`) | Both lists, each entry with a Remove button |
| Command | `/some-leaks ignore <entry>` for this project, `/some-leaks ignore --global <entry>`, `/some-leaks unignore [--global] <entry>`; `--global` may stand anywhere |
| `/config` | The `Ignored everywhere` and `Ignored per folder` rows |

- Only findings of the current session have the Ignore buttons: stored values are masked, so the full value is known only while the session runs, in memory
- Every change applies at once, no restart needed

## Security Limits

| Limit | Why |
| --- | --- |
| Known formats only | Values written in an unusual format, and encoded data (base64, hex), are not detected |
| Not adversarial | Redaction stops accidents, not a model working around it: a prompt injection can make the model transform data (for example `base64 file.csv`) so no pattern matches |
| Images and PDFs | Not scanned; in `redact` mode they reach the model as they are |
| Fixed context | Some attached context is sent as recorded by the engine and cannot be rewritten |
| System prompt and internal calls | Not verified: the system prompt, and model calls Claude Code makes on its own (such as summarizing a fetched page), may not pass through the mod |
| Local transcript | The session file on disk keeps the tool's original output |
| Same access as Claude Code | Like every mod it is not sandboxed; read the diff of a new version before `claude plugin update` |

- The mod makes no network call; everything it stores stays in `~/.claude/plugins/store`, readable by your user only
- In `notify` mode, or with `failClosed` off, a scan that fails lets the content through
- For data that must never leave, also deny Claude access to those folders with a permission rule

## How It Works

```mermaid
sequenceDiagram
    actor User
    participant CC as Claude Code
    participant Mod as leaks mod
    participant Tool as Tool
    participant Store as Local history
    participant API as Anthropic API

    User->>CC: Prompt
    CC->>Mod: prompt.submit
    Mod->>Mod: Mode of the session's folder
    alt block mode, sensitive data found
        Mod-->>User: Prompt refused, put back with the values underlined
    else
        Mod->>CC: Prompt passes
        CC->>API: Request
    end
    API-->>CC: Tool call, for example Read fixtures/config.env
    CC->>Mod: tool.call
    Mod->>Mod: Stricter of the session's mode and the file folder's
    alt redact mode, a writing tool with placeholders
        Mod-->>CC: Call refused
    else
        Mod->>Tool: Call passes
        Tool-->>CC: Result with an API key and a database password
    end
    CC->>Mod: session.append, the result row
    Mod->>Mod: Local scan, skipped in off mode
    alt off or notify mode
        Mod->>CC: Row unchanged
    else redact mode
        Mod->>CC: Values replaced by [redacted:kind]
    else block mode
        Mod->>CC: Content replaced by a withheld notice
    end
    CC->>API: Next request, built from the row as stored
    Mod-)Store: Findings, masked, 250 ms later
    Mod-)User: Toast and status line
```

- `prompt.submit`, `tool.call` and `session.append` all run on your machine, before the request is sent
- The session's folder is read again on each prompt, so `/cd` and worktree moves are followed
- Side model calls from other mods go through `model.complete` and `model.fork` and get the same treatment
- Subagents append their rows the same way

## Sources

| Source | Shown as |
| --- | --- |
| Your prompt | Sent by you: prompt |
| A tool result | Read by a tool: `Read fixtures/config.env`, `Bash`, `WebFetch example.org` |
| The model's reply or tool input | Written by the model: reply, `Write src/seed.ts` |
| Files mentioned, memory, hook context | Added as context: the attachment type |
| Another mod's `$.model.complete` or `$.model.fork` | Side model call |

Subagent rows carry `(subagent)` after the source.

Sources keep the tool and the file path, or the host of a URL. Commands, search patterns and full URLs are never stored: they can hold tokens or passwords.

## Detection

### Personal Identifiers

| Kind | Rule | Shown as |
| --- | --- | --- |
| Email | Address with a real top-level domain (`logo@2x.png` skipped) | `j***@gmail.com` |
| Phone | `+` or `00`, a country code, and a national number of the right length for that country (8 to 15 digits in all); French national numbers (`0` and 9 digits), counted as the same value as their `+33` form | last 2 digits |
| IBAN | Checksum verified | country, key and last 4 |
| Card number | 13 to 19 digits, Luhn verified | last 4 |
| Social security (FR) | NIR with a valid key | first digit and key |
| National number (BE) | Birth date, serial and mod-97 key | last 2 digits |
| DNI/NIE (ES) | 8 digits, or X, Y or Z and 7 digits, with a valid letter | letter |
| Codice fiscale (IT) | 16 characters with a valid check letter | check letter |
| SSN (US) | `123-45-6789` form, invalid ranges skipped | last 4 |

### Secrets

| Kind | Rule | Shown as |
| --- | --- | --- |
| API key | Known prefixes: AWS (`AKIA`, `ASIA`), GitHub, GitLab, Anthropic, OpenAI, Stripe, Slack tokens and webhooks, Google, npm, SendGrid, Hugging Face | first and last 4 characters |
| Private key | `-----BEGIN ... PRIVATE KEY-----` block, also escaped inside JSON | the header line |
| URL password | `scheme://user:password@host`; `${VAR}`, `***` and words like `password` skipped | the URL with the password hidden |
| JWT | `eyJ...` header, payload and signature | length only |

- A value already claimed by one kind is not reported again by another (an IBAN's digits are not a card)
- Secrets are never stored whole, even with `storeRawValues` on

## Pane

| Control | Hotkey |
| --- | --- |
| Findings: one entry per value, latest first, with count, first and last time, latest source | `f` |
| Timeline: the 100 latest occurrences, with time and source | `t` |
| Filter all, private, secrets | `a` / `p` / `s` |
| Rules: this project's mode, the default mode, the mode rules, the ignore lists | `r` |
| Ignore a finding of this session, here or everywhere | "Ignore here", "Ignore everywhere" |
| Another project | project picker |
| Clear the project's history | "Clear project", then confirm |

Each occurrence says what was done with it: `seen`, `redacted` or `blocked`. The session's mode, and the rule it comes from, shows under the project name.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `redact`, `notify`, `block`, `off` | `redact` | Default mode, where no rule applies: values replaced by placeholders, recorded only, withheld, or not scanned |
| `rules` | string | empty | Modes per folder, `folder=mode` entries separated by commas (see Modes per Folder) |
| `failClosed` | boolean | `true` | In `redact` and `block` modes, a scan that fails or runs out of time withholds the content (or refuses the prompt or side call) instead of letting it through |
| `notify` | `toast`, `system`, `both`, `off` | `toast` | How a new finding is announced |
| `storeRawValues` | boolean | `false` | Keep full personal identifiers in the history instead of masked ones; secrets stay masked |
| `ignore` | string | `*example.com,*example.org,*example.net,*noreply*,*no-reply*,git@github.com,git@gitlab.com,*plugins/leaks/hooks*` | Entries ignored everywhere, separated by commas (see Ignore Lists) |
| `folderIgnore` | string | empty | Entries ignored per folder, `folder=entry\|entry` items separated by commas |
| `retentionDays` | number | `90` | Days of occurrences kept; older ones are deleted when a session starts |

Change `mode`, `rules`, `ignore` and `folderIgnore` from the pane, the command or `/config`, at once. Change the others, then restart Claude Code:

```bash
echo '{"mode":"notify","notify":"both","ignore":"example.com,mycompany.com"}' | claude plugin configure leaks@somelife-claude-mods --values-stdin
```

## Trying It

`fixtures/clients.csv` holds made-up people with an identifier of every kind; `fixtures/config.env` holds an example API key, a database password and a JWT. Start a session with the mod, from the repository root:

```bash
claude --plugin-dir plugins/leaks
```

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Send `My email is jane.doe@gmail.com and my phone +33 6 12 34 56 78. Just reply OK.` | A "Sensitive data redacted" toast; Claude reads `My email is [redacted:email] and my phone [redacted:phone]` |
| 2 | Ask `Read plugins/leaks/fixtures/clients.csv and quote its emails` | Claude only sees `[redacted:email]`; the toast names `Read plugins/leaks/fixtures/clients.csv` |
| 3 | Ask `Read plugins/leaks/fixtures/config.env` | Claude sees `[redacted:api-key]`, `postgres://app:[redacted:url-password]@db.internal` and `[redacted:jwt]` |
| 4 | Ask Claude to write that content back to the file | The write is refused |
| 5 | Run `/some-leaks` | One entry per value, each `redacted`; `s` shows the secrets only |
| 6 | Run `/some-leaks default notify`, then send the prompt of step 1 | A "Sensitive data seen" toast; Claude reads the prompt as typed |
| 7 | Run `/some-leaks mode block`, then send a prompt holding `4111 1111 1111 1111` | The prompt is refused and put back in the box, the number underlined |
| 8 | Ask Claude to read `fixtures/config.env` | Claude only gets the withheld notice |
| 9 | Press `r` in the pane, then `Default` under This project | The rule is gone; the session is back to the default mode |

- Change `mode` from the pane's `Modes` tab, `/some-leaks default <mode>` or `/config`: it applies at once
- A value is notified once per session: later steps count it in the pane without a new toast
- A dim `leaks:` line in the transcript means a hook failed or the module did not load
- Automated tests: `claude plugin test plugins/leaks`

## Data

- Stored in the mod's own store under the Claude Code configuration directory, one entry per project
- Values are masked before storage unless `storeRawValues` is on, and secrets always are
- Each value is recognised again by a 96-bit SHA-256 id, keyed with a random secret made on first use: without the secret, ids cannot be matched against guessed values, nor compared across machines
- The secret is kept in the same store: whoever can read the store can still test guesses one value at a time
- Notifications show masked values only
- Up to 300 findings per project, the oldest dropped first
- Findings of kinds an older version detected (health terms, dates of birth) are dropped when a session starts
- Nothing leaves your machine
