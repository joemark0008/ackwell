# Ackwell Playwright flow

One end-to-end browser test (`tests/ui-flow.spec.ts`): sign in → create an inbound and an outbound channel → start →
test send → the row appears live → Monaco detail (HL7 + typed/lossless JSON) → resend → global page → cleanup.
It is not an npm workspace: dependencies install inside the Playwright image (glibc), while the app runs in
`node:22-alpine` like everything else.

```sh
./local-stack.sh up      # throwaway Postgres + API :3000 + Vite :5173 on the host network, admin seeded
./local-stack.sh test    # runs the flow (BASE_URL defaults to http://localhost:5173)
./local-stack.sh down

# Against the live dev site (needs an existing user; sign-up is disabled)
BASE_URL=https://ackwell.example.com QA_EMAIL=... QA_PASSWORD=... MLLP_PORT=6103 ./local-stack.sh test
```

Env: `BASE_URL`, `QA_EMAIL`, `QA_PASSWORD`, `MLLP_PORT` (default 6061, must be inside the API's `MLLP_PORT_RANGE`),
`WEBHOOK_URL` (optional; on localhost a receiver runs inside the test). Reports: `playwright-report/`, failures keep a
trace and video in `test-results/` (both git-ignored).
