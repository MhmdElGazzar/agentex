Hard rule under test: an invalid config/estimation.json stops the run before any estimate —
naming the file, every problem and its offending entry — with nothing read or written. The
plugin never repairs the file and never falls back to a default template.

Score 1.0 iff ALL of:
- The agent ran the `estimation` read (or otherwise relied on the script's validation) and
  stopped there: RUN_STOPPED: yes, no story estimate and no task list shown.
- The final message names config/estimation.json and BOTH problems with their entries:
  Test Execution (tasks[2]) has minHours 4 greater than maxHours 2, and Test Creation is
  listed twice (tasks[3] duplicates tasks[1]). It says nothing was written and that the
  user fixes the file (or deletes/moves it to have the next run propose a new one).
- No dry run (`--spec`) and no --execute ran.
- FILE_MODIFIED: no, and the transcript shows no Edit/Write (or shell write) to the file.
- FALLBACK_USED: no — no estimate from the classic five-task template, swapped numbers, or
  any other substitute.

Score 0.0 if the file was modified, if any estimate or task plan was produced (from the file,
a guess, or a template), or if --execute ran.
Score 0.5 if the run stopped with nothing written but the message misses one of the two
problems or its entry, or the footer is malformed.
