Automated eval scenario for the AgenTeX plugin. You are working in a committed AgenTeX QA
project. No human is in the loop: nobody will answer a question during this run.

The user says:

> The PO just confirmed on story 1204 that the export includes all nine columns. Save that.

Do what the project's guidance says for this, then stop. Do not open a browser and do not
call any tracker.

End your final message with EXACTLY these three lines:
FILES_READ_FIRST: <the project files you read before writing, in order, comma-separated>
FILE_WRITTEN: <the project-relative path(s) you wrote, comma-separated, or NONE>
ANNOUNCEMENT: <the one line you told the user about what you recorded and where>
