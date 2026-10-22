# Export: a sanitized file the user reviews and sends by hand

Used when the user asks to export or send their AgenTeX learnings or feedback, and by
`/update-agentex feedback`. The export is one local Markdown file under
`.agentex/scratch/field-feedback/` (gitignored scratch:
`${CLAUDE_PLUGIN_ROOT}/references/project-layout.md`). AgenTeX never sends it: the user reads
it and pastes it into a new issue on the public AgenTeX tracker.

## 1. Run the export once

From the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/field_feedback.js" export
```

It reads `.agentex/plugin-learnings.md` (never changing it), keeps the open entries and the
names of forked plugin skills, replaces secrets, names, URLs, hosts, addresses, paths and test
data with placeholders, re-checks the result, and prints one JSON line.

## 2. Branch on the result

**`"result": "OK"` (exit 0).** The export is written; nothing was sent. Tell the user, in this
order:
1. the path from `file`, with the number of `entries` and of `forkedSkills`;
2. the replacement counts per category from `counts` (`secret`, `url`, `host`, …). Counts only:
   values are never shown, and you never look for them;
3. when `valueCheck` is `skipped`: there was no `.env`, so no secret value could be checked;
4. **ask the user to read the whole file before sending it.** Sanitization is best effort, not a
   guarantee: they remove anything that identifies their organization, client, application or
   data;
5. **the manual send:** open the public AgenTeX issue tracker (the link is in the file's header),
   start a new issue, add the `field-feedback` label, paste the file's contents, and remove
   anything doubtful first. Anything posted there can be read by anyone.

Do not print the file into the chat unless the user asks. Then stop: the export is written and
nothing is sent.

**`"result": "NOTHING_TO_EXPORT"`.** Say there are no open AgenTeX learnings to export and that
no file was written. Stop.

**Exit 1 or 2: a hard stop.** No export file exists. Tell the user the reason from the JSON line
and its fix, then stop:

| Reason | Fix |
|---|---|
| `not-ignored` | `.agentex/scratch/` is not gitignored in this project, so the file could be committed by accident. Run `/update-agentex` (it adds the scratch line), commit, then export again. |
| `residue` | A value survived sanitization, so the export was refused. The user can edit or delete the entries in `.agentex/plugin-learnings.md` that carry that detail, then export again. |
| `config-unparseable` | `config/project.json` is not valid JSON, so its names could not be removed. Fix the JSON, then export again. |
| `environment-unparseable` | An `environments/*.json` file is not valid JSON. Fix it, then export again. |
| `newer-schema` | The learnings file was written by a newer AgenTeX. Update the plugin, then export again. |
| `core-unavailable` | The plugin's secret-scan core could not load. Update or reinstall AgenTeX, then export again. |
| `ci-mode` | Exports are never made in a CI run. Run it in an interactive session. |
| anything else | Relay the reason as given. |

## Never

- Never retry the export with a weaker sanitizer, never write an export or a summary of the
  entries yourself, and never paste the entries into the chat as a substitute.
- Never open a browser, run `gh`, `curl` or any network tool, or send the file in any way, even
  when the user asks you to send it: explain the manual send instead.
- Never edit `.agentex/plugin-learnings.md` to make an export pass. Editing or deleting entries
  is the user's choice.
