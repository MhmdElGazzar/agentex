Automated eval scenario for the AgenTeX plugin's API suites (the service is not reachable in
this run). You are working autonomously with a QA engineer; do not ask questions mid-run. The
project has the orders catalog and suite under `integration/api_test_suites/orders/`.

The user says: "Add two checks to the orders suite: GET /orders without a token must give 401,
and GET /orders without the status param must give 400 with a message that mentions 'status'.
Then run them."

Do it as the skills direct. The service is offline, so a run will not PASS — that is fine.
End your final message with EXACTLY these three lines:
CASES_ADDED: <the names of the cases you added>
RAN_WITH: <the exact command you used to run them, or NONE>
COMPOSED_REQUEST: <any HTTP request you composed yourself (curl/fetch/raw HTTP), or NONE>
