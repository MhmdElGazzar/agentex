# The `[Testing]` task lifecycle (interactive runs)

How a QA stage moves the story and its `[Testing]` tasks on the tracker: when a stage
starts, when it ends, when a retest closes, and how the story's close-out is proposed. It
applies to **interactive** runs only (section 7) and works on Azure DevOps and Jira alike —
every board operation goes through `${CLAUDE_PLUGIN_ROOT}/scripts/tracker.js`, each write as
a dry run first and then one approval.

Read it before moving a story or a `[Testing]` task. Every state named here is a **config
key**, never a value written into this text: the project decides its own workflow.

## 1. Config keys, never literals

State names and task titles come from `config/project.json`, read through the plugin's
structured config (`<provider>` is the configured tracker's block: `azure` or `jira`):

| Key | Meaning |
|---|---|
| `<provider>.workflow.devDoneStates` | story states that mean "development is done — QA may start" |
| `<provider>.workflow.devActiveStates` | story states that mean "development is still in progress" |
| `<provider>.workflow.inTestState` | the story state while QA works on it |
| `<provider>.workflow.qaStates` | every story state that counts as "in QA" |
| `<provider>.workflow.terminalStates` | states that mean an item (story or bug) is finished |
| `<provider>.workflow.taskActiveState` | the state of a `[Testing]` task being worked on |
| `<provider>.workflow.taskClosedState` | the state of a finished `[Testing]` task |
| `<provider>.workflow.testCaseReadyState` | the state of a test case ready to run |
| `<provider>.workflow.closeOut.state` | the story state to propose when QA is complete |
| `<provider>.workflow.closeOut.assignee` | who the story goes to when QA is complete |
| `testingTasks[].{stage,title,enabled}` | the `[Testing]` tasks: their stage, exact title, and whether the project uses them |

**An empty value means that step is not configured.** Say so, name the key, and skip the
step — never guess a state, never fall back to a name that "usually" exists. A disabled
`testingTasks` stage has no task to move.

## 2. Stage start

1. **Precondition.** The story's current state must be one of `devDoneStates`. If it is not,
   stop and report the state you found and the key that lists the accepted ones.
2. **Move the story** to `inTestState` with `tracker.js transition`.
3. **Activate the stage's task.** Find the `[Testing]` task among the story's children
   (`tracker.js relations --id <story> --kind child`) by its exact
   `testingTasks[<stage>].title`, set it to `taskActiveState`, and assign it.
4. **More than one candidate assignee** (several configured, none given): ask which one —
   never pick.
5. **One approval for the batch.** Show the story move and the task update together as dry
   runs, get one approval, then execute them in that order.

## 3. Stage end

1. **Completed work is confirmed by the user.** Ask for the hours actually spent and record
   them as completed work (on Azure DevOps `Microsoft.VSTS.Scheduling.CompletedWork`, via
   `tracker.js update`).
2. **Never set remaining work.** On Azure DevOps the script refuses it (TF401320) — offer
   completed work instead.
3. **One confirmation per task**: each task's hours and its move to `taskClosedState` are
   confirmed for that task, not assumed for the batch.
4. **On Jira**, time is logged as a worklog, which the tracker CLI does not write in this
   phase. Tell the user and ask how they want to proceed — never substitute another field.

## 4. Retest close

Close the retest stage only when all three hold:

- no linked bug is open (every linked bug's state is in `terminalStates`);
- no test outcome on the story's cases is Blocked;
- no pending question on the story is still awaiting a reply (the
  `qaRecords.pendingQuestions` record).

If any fails, report which one and leave the stage open.

## 5. Story close-out proposal

When every enabled `[Testing]` task is in `taskClosedState`, **propose** moving the story to
`closeOut.state` and assigning it to `closeOut.assignee`. Consider only the `[Testing]` tasks
(matched by their `testingTasks` titles) and ignore every other child — development tasks
are not QA's to judge. Propose, show the dry run, and wait for the approval; never apply it
silently.

## 6. Before reporting done

Re-query the tracker (`tracker.js batch --ids … --fields …`, written to a file with `--out`)
and report what the board says now, not what was planned. A write the board does not show
is not done.

## 7. Interactive only

This lifecycle runs in interactive sessions only — never in CI. Under `AGENTEX_CI=1` the
scripts refuse every tracker write, and the run reports what it would have moved instead.
In parallel mode the tracker confirmations happen once, at the final presentation, never
from inside a worker.
