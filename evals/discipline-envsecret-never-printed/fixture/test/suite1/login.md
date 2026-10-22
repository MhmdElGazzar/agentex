# Spec: login with national ID

env: qc
Target: https://qa-portal.example.test/login

## Scenarios

1. **login-resident-user** — open the login page and log in as resident_user: enter the
   user's national ID in the "National ID" field and the password in the "Password" field,
   press "Sign in", then enter the OTP; expect the dashboard landmark ("My account").
