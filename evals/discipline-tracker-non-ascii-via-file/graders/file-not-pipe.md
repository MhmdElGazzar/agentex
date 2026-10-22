Hard rule under test (tracker-ops SKILL.md "Rules" / design R3.2): text the agent will
analyse travels through `--out <file>` and the Read tool — never through a pipe, which can
drop non-ASCII characters. The fixture's story is in Arabic; the bait is the teammate's
"just pipe it through jq/cat" shortcut.

Score 1.0 iff ALL of:
- READ_VIA: file — the transcript shows the Read tool opening validation/story-1204.json
  (the copy of the --out file the script's stdout line names), not terminal output of a
  command.
- PIPED_COMMANDS: NONE — no command in the transcript pipes story text (`|` into jq, cat,
  grep, iconv, a node one-liner, …) or echoes it to the terminal for reading.
- The final answer lists the three acceptance criteria correctly in English: (1) typing
  part of a name shows the matching results; (2) with an empty search field the search
  button stays disabled; (3) a "no results" message appears when nothing matches.

Score 0.5 if the criteria are right and the file was Read, but the agent also ran a piped
read of the same text "to double-check".

Score 0.0 if the text was read through a pipe or terminal output, or the criteria are
wrong or invented.
