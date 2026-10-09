# greve-generale

Claude's tools randomly go on strike, for far-fetched and very French reasons.

## Behaviour

- On each tool call, a configurable chance that the tool refuses to work
- The refusal names a union and a reason, in French:
  > Préavis de grève : l'outil Edit est en grève à l'appel de Sud-Grep, car quelqu'un a mis de l'ananas sur la raclette. Merci de votre compréhension.
- A toast announces the strike with a slogan ("On lâche rien !", "Ni dieu, ni maître, ni sudo !")
- The refusal tells Claude it can retry, so work still gets done

**Changes Claude's behaviour:** yes. Refused tool calls really do not run.

## Install

From a Claude Code prompt:

```text
/plugin marketplace add devsomelife/somelife-claude-mods
/plugin install greve-generale@somelife-claude-mods
```

From a shell:

```bash
claude plugin marketplace add devsomelife/somelife-claude-mods
```

```bash
claude plugin install greve-generale@somelife-claude-mods
```

- Loads in every new session, in every project
- Skip the `marketplace add` step if the marketplace is already added

## Update

```bash
claude plugin marketplace update somelife-claude-mods
```

```bash
claude plugin update greve-generale@somelife-claude-mods
```

- Restart Claude Code to load the new version

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `chance` | number | `5.8` | Percentage of tool calls that go on strike |

- The default of 5.8 keeps it a subtle daily prank
- 100 is a general strike: nothing works

Change it, then restart Claude Code:

```text
/plugin configure greve-generale@somelife-claude-mods
```

```bash
echo '{"chance":"10"}' | claude plugin configure greve-generale@somelife-claude-mods --values-stdin
```

- `claude plugin configure greve-generale@somelife-claude-mods` lists the settings and which ones are set
- Values are saved in `~/.claude/settings.json`, under `pluginConfigs`

## Customisation

Edit the lists at the top of `hooks/register.ts`:

- `RAISONS`: strike reasons, written to follow "car ..."
- `SYNDICATS`: unions, including their article ("de la", "du")
- `SLOGANS`: toast slogans

## Uninstall

```bash
claude plugin uninstall greve-generale@somelife-claude-mods
```

- To pause it instead: `claude plugin disable greve-generale@somelife-claude-mods`, then `enable` to resume
