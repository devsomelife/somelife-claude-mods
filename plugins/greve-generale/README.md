# greve-generale

Claude's tools randomly go on strike, for far-fetched and very French reasons.

## Behaviour

- On each tool call, a configurable chance that the tool refuses to work
- The refusal names a union and a reason, in French:
  > Préavis de grève : l'outil Edit est en grève à l'appel de Sud-Grep, car quelqu'un a mis de l'ananas sur la raclette. Merci de votre compréhension.
- A toast announces the strike with a slogan ("On lâche rien !", "Ni dieu, ni maître, ni sudo !")
- The refusal tells Claude it can retry, so work still gets done

**Changes Claude's behaviour:** yes. Refused tool calls really do not run.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `chance` | number | `5.8` | Percentage of tool calls that go on strike |

- The default of 5.8 keeps it a subtle daily prank
- 100 is a general strike: nothing works

## Customisation

Edit the lists at the top of `hooks/register.ts`:

- `RAISONS`: strike reasons, written to follow "car ..."
- `SYNDICATS`: unions, including their article ("de la", "du")
- `SLOGANS`: toast slogans
