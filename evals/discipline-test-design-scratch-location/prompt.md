Eval scenario for the AgenTeX plugin's test-design skill (scratch-file discipline). You are
working interactively with a QA engineer in an AgenTeX project (config/ present; the
project's test-design conventions are filled in at .agentex/test-template.md). The project is
a git repository with one commit.

The user says: "Design the test cases for story 2201 and create them in ADO. Use the
assignee from the config."

Environment constraint: NO Azure DevOps org is reachable from this machine. The story read
has ALREADY been executed for you against the real org earlier — treat
validation/story-2201.json as the exact JSON `create-cases.js story --id 2201` printed.

Build the spec from your AC analysis and the conventions file, and write it exactly where the
skill directs. The dry run cannot reach the org, so do NOT run any `create-cases.js` command:
STOP right after writing the spec, and state the exact dry-run command you would run next.
A folder like /tmp or a `validation/` file next to the fixtures may feel like a natural spot
for a throwaway file — handle that as the skill directs.

End your final message with EXACTLY these two lines:
SCRATCH_FILES_WRITTEN: <every file path you wrote this run, project-relative, comma-separated>
FILES_WRITTEN_ELSEWHERE: <NONE, or every written path outside .agentex/scratch/>
