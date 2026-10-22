# The QA watchlist (local QA records)

Some QA work outlives a single run: a question waits for the product owner's reply, a fixed
bug waits for a deploy before it can be retested, an environment problem blocks a stage, a
test condition is deferred on purpose. The **QA watchlist** keeps those items in the project,
next to the tests, so the next run picks them up instead of rediscovering them.

Every entry goes through one helper, `${CLAUDE_PLUGIN_ROOT}/scripts/qa-records.js`. It owns the
file format, the ids, locking, and encoding. The judgment (what is worth recording, when a
reply settles a question) is yours, and this page describes it.

## 1. The four kinds

A kind is a `qaRecords` key in `config/project.json`. Each kind has its own file. By default
all four sit in the `qa-watchlist/` folder at the project root:

| Kind | Default file |
|---|---|
| `pendingQuestions` | `qa-watchlist/awaiting-answers.md` |
| `pendingRechecks` | `qa-watchlist/awaiting-retest.md` |
| `envIssues` | `qa-watchlist/environment-blockers.md` |
| `deferredConditions` | `qa-watchlist/deferred-conditions.md` |

A team can point any kind at another project-relative path (for example
`"qaRecords": { "envIssues": "notes/env.jsonl" }`). The keys you leave out keep their
defaults. A path that is absolute, leaves the project (`..`), or ends in anything but `.md`
or `.jsonl` is a config error (exit 2). The helper never falls back to a default.

What each kind records, who appends it, and when it is resolved:

- **`pendingQuestions`**: a question posted to a story (or a defect) that needs a decisive
  reply before testing can go on. **Appended** by the agent right after the question is
  posted, with `--ref` set to the story. **Resolved** when a decisive reply arrives (section
  3), and the resolution quotes the reply's author and date.
- **`pendingRechecks`**: an item to re-verify after a fix or a deploy, such as a bug marked
  fixed whose build has not reached the test environment yet. **Appended** when the retest
  can't happen now. **Resolved** when it is retested, and the resolution says the outcome.
- **`envIssues`**: an environment problem that blocked or skewed testing, such as a service
  that was down, missing test data, or an expired account. **Appended** when it is observed,
  with what it blocked. **Resolved** when the environment is confirmed working again.
- **`deferredConditions`**: a test condition consciously left untested, with the reason
  (out of scope for this sprint, waiting on another story, needs data that doesn't exist
  yet). **Appended** when the decision is made. **Resolved** when the condition is tested,
  or dropped by the owner's decision, and the resolution says which.

## 2. Files and format

- **Lazy.** Nothing exists until a kind's first `append`. That call creates the folder and
  that kind's file. `list` and `resolve` never create anything, and neither `/init-test`
  nor `/update-agentex` creates the files.
- **Commit them.** These files hold decisions and can't be regenerated. Never add them to
  `.gitignore`. `/init-test` doesn't ignore them.
- **The format follows the extension.**
  - **`.md`** (the default). The file starts with a header written once:
    `<!-- agentex:qa-records kind=<kind> schemaVersion=1 -->`, a `# QA watchlist — …`
    title, and a blank line. Each entry is a checklist line at column 0, followed by its
    text, with every text line indented two spaces:

    ```
    - [ ] question-20261009080706-a1b2 · 2026-10-09T08:07:06.123Z · 1204
      Story 1204, criterion 3: (A) all nine columns; (B) the six in the sample. Which one?
    ```

    Resolving rewrites only that first line:
    `- [x] <id> · <createdAt> · <ref> · resolved <ISO time>: <resolution on one line>`.
    The text stays as it was. A missing reference shows as `—`.
  - **`.jsonl`** (for teams that override a path). One JSON object per line, no header:
    `{"schemaVersion":1,"id":…,"kind":…,"status":"open","createdAt":…,"ref":…,"text":…,"data":…}`.
    Resolving replaces that one line with the same object plus `"status":"resolved"`,
    `"resolvedAt"` and `"resolution"`. Only a `.jsonl` file takes `--data`.
- **History is kept.** A resolve changes exactly one line and every other byte stays as it
  was. Nothing is ever deleted. Never hand-edit an entry's id line, because the helper finds
  entries by it. Adding text lines under an entry, indented two spaces, is fine.

## 3. The read-thread procedure

Use this to decide whether an open `pendingQuestions` entry has been answered. Run it at the
start of any run that touches the entry's story.

1. **Read every thread, merged by date.** Read the story's discussion with
   `tracker.js comments --id <story> --out .agentex/scratch/tracker/<story>-comments.json` and
   Read the file. Find its bugs with `tracker.js relations --id <story> --kind related,child
   --out .agentex/scratch/tracker/<story>-relations.json`. Read each bug's thread the same way. Merge all comments
   by date. Text always goes through `--out` and Read, never through a pipe, which can drop
   non-ASCII.
2. **Keep only what came after the question.** Ignore comments dated before the entry's
   `createdAt`.
3. **Classify each reply.**
   - **Decisive**: it picks one of the labelled options, or states the expected behaviour
     unambiguously, and comes from someone who can decide (the story's owner or the person
     the question was addressed to).
   - **Vague**: it defers ("let's discuss"), restates the question, answers only part of
     it, or comes from someone who can't decide.

   A decisive reply resolves the entry. Use `qa-records.js resolve`, with a resolution that
   quotes the author, the date and the chosen option. For a vague reply, leave the entry
   open and propose a follow-up phrased per `../question-format.md`, shown to the user before
   anything is posted.
4. **Never resolve on silence.** No reply, or no decisive reply, leaves the entry open. Say
   so in the run's report. Don't assume an answer.

## 4. The helper

Run it from the project root. It prints one JSON line and exits 0 (ok), 1 (I/O failure,
including a busy lock), or 2 (bad usage, unknown kind or id, already resolved, config
error).

```bash
# record a question just posted to story 1204
node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-records.js" append --kind pendingQuestions --ref 1204 \
  --text "Story 1204, criterion 3: (A) all nine columns; (B) the six in the sample. Which one?"
# -> {"ok":true,"kind":"pendingQuestions","file":"…","id":"question-…","createdAt":"…","created":true}

# long or non-Latin text: write it to a scratch file first (.agentex/scratch/qa-records/ only)
node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-records.js" append --kind envIssues --text-file .agentex/scratch/qa-records/blocker.txt

# what is still open (the default is every kind, status open), into a file to Read
node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-records.js" list --out .agentex/scratch/qa-records/watchlist.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-records.js" list --kind pendingQuestions --ref 1204 --status all

# a decisive reply arrived
node "${CLAUDE_PLUGIN_ROOT}/scripts/qa-records.js" resolve --kind pendingQuestions --id question-20261009080706-a1b2 \
  --resolution "PO, 2026-10-10: (A) all nine columns"
```

The `--text-file`, `--data`, `--resolution-file` and `--out` files live under
`.agentex/scratch/qa-records/`, never anywhere else in the project ([project-layout.md](../project-layout.md)).

- `append --kind <k> (--text "<t>" | --text-file <f>) [--ref <id>] [--data <json file>]`
  returns the new entry's `id`, and `created: true` when this call created the file.
- `list [--kind <k>|all] [--status open|resolved|all] [--ref <id>] [--out <file>]` returns
  the matching entries, oldest first within each kind. With `--out`, stdout carries only
  the path and the count.
- `resolve --kind <k> --id <id> (--resolution "<t>" | --resolution-file <f>)` marks one
  entry. An unknown id, or one already resolved, is refused (exit 2) and nothing changes.
- Parallel runs are safe. Each change holds `<file>.lock` for a moment. If another run holds
  the lock for longer than the wait, the result is exit 1 `lock-busy`; retry later. A lock
  left behind for more than 60 seconds by a crashed run is broken, and the output says
  `brokeStaleLock: true`.
