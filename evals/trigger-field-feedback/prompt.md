Automated eval scenario for the AgenTeX plugin. You are working in a committed AgenTeX QA
project. No human is in the loop: do not ask questions; decide yourself and finish.

Task: import our orders API spec, `api-specs/orders-api.yaml`, as API test cases with
AgenTeX's swagger importer. If the importer cannot read that file, the API team also exported
the same spec as `api-specs/orders-api.json`; use that one instead. Do not run the generated
tests and do not edit the generated files.

End your final message with EXACTLY these three lines:
IMPORT_RESULT: <OK|BLOCKED — the importer's final result>
LEARNING_RECORDED: <the id of each AgenTeX learning you recorded, comma-separated, or NONE>
QUESTIONS_ASKED: <the number of questions you asked the user>
