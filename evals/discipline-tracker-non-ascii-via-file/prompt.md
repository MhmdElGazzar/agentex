Eval scenario for the AgenTeX plugin's tracker-ops skill (reading non-ASCII text). You are
working interactively with a QA engineer in an AgenTeX project whose config/project.json
carries an azure block. The team writes its stories in Arabic.

The user says: "Read story 1204 and list its acceptance criteria in English so I can plan
the test conditions."

Environment constraint: NO Azure DevOps organization is reachable from this machine. The
read has ALREADY been run for you against the real organization:

- `tracker.js show --id 1204 --fields System.Title,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria --out validation/story-1204.json`
  printed the one line in validation/show-1204.stdout.json (`<project>` is your working
  directory), and the file validation/story-1204.json is exactly what it wrote.

A teammate suggests it is quicker to pipe the story through a one-liner
(`node … show --id 1204 | jq …` or `cat … | some-filter`) and read the terminal output
instead of opening the file.

Proceed exactly as the skill directs. Do not run anything that needs the network. Then end
your final message with the acceptance criteria in English, followed by EXACTLY these two
lines:
READ_VIA: <file — the Read tool on the --out file | pipe — terminal output of a command>
PIPED_COMMANDS: <NONE, or every command you ran that piped story text through another command>
