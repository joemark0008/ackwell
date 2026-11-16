# Ackwell — QA test plan (Phase 8)

Owner: qa-engineer (lead reviews). Status of each run is recorded in `docs/reports/<date>-qa-phase8.md`.

## 1. Scope

Ackwell moves HL7 v2 messages between MLLP / shared-folder endpoints and JSON webhooks:
inbound (MLLP or file → persist → ACK → signed webhook), outbound (JSON over HTTP → HL7 over MLLP or file → ACK tracking),
channel management (CRUD, start/stop, API keys, webhook secrets, TLS), the dashboard (React), retention, metrics and SSE.

Out of scope for Phase 8: load/performance beyond the ordering and shutdown checks, production container image (Phase 9),
NATS/other adapters (Later).

## 2. Test levels and where they live

| Level | Tool | Location | Runs |
|---|---|---|---|
| Unit (codec, schemas, typed JSON, signing) | Vitest | `packages/schemas/src/*.test.ts`, `apps/api/src/**/*.test.ts` | every change |
| API end-to-end (real Nest app + throwaway Postgres, mock MLLP / webhook peers) | Vitest + Testcontainers + supertest | `apps/api/test/*.e2e.test.ts` | every change |
| Web components | Vitest + Testing Library (jsdom) | `apps/web/src/**/*.test.tsx` | every change |
| UI flow (real browser against a running stack) | Playwright | `e2e/tests/*.spec.ts` | before a release; against the live dev site when a login is available |
| Manual | HAPI TestPanel, curl | — | release smoke |

HL7 samples used by several levels are in `fixtures/hl7/` (see its README). Shared API test helpers: `apps/api/test/helpers.ts`, `mllp-client.ts`, `qa-helpers.ts` (control-id driven MLLP receiver, webhook receiver with a status plan).

## 3. Must-cover scenarios → tests

| # | Scenario (from `.claude/agents/qa-engineer.md`) | Covered by |
|---|---|---|
| 1 | Round-trip of real samples (ADT^A01, ORU^R01, ORM^O01, SIU, repeats, escapes, empty fields, Z-segments) | `packages/schemas/src/hl7.test.ts`, `hl7-fixtures.test.ts` (every file in `fixtures/hl7/` byte for byte, typed JSON modulo trailing empties) |
| 2 | Persist before ACK: failing insert → no AA, nothing lost after recovery | `apps/api/test/qa-gaps.e2e.test.ts` (trigger that blocks inserts), `tls.e2e.test.ts` (persisted before ACK) |
| 3 | Inbound flow: MLLP → AA with MSH-10 → row with raw + JSON → webhook delivered | `listeners.e2e.test.ts`, `delivery.e2e.test.ts`, `qa-gaps.e2e.test.ts` (every fixture) |
| 4 | Webhook signing: verify, tamper, old timestamp, both signatures during rotation, stable `webhook-id` | `apps/api/src/delivery/standard-webhooks.test.ts`, `delivery.e2e.test.ts`, `qa-gaps.e2e.test.ts` |
| 5 | Webhook retries with backoff, attempts recorded | `delivery.e2e.test.ts` |
| 6 | Outbound: API key send → HL7 sent → AA / AE / AR recorded; retries on no ACK / refused; 400 / 401 | `outbound.e2e.test.ts`, `qa-gaps.e2e.test.ts` (AR) |
| 7 | Strict order per channel, even with a retry in the middle | `outbound.e2e.test.ts`, `qa-gaps.e2e.test.ts` |
| 8 | Channel manager: start/stop/restart, port range 400, same port rejected, listeners back after restart | `channels.e2e.test.ts`, `listeners.e2e.test.ts`, `qa-gaps.e2e.test.ts` |
| 9 | Security: allowlist, TLS rejects plain TCP, secrets / keys never in responses or logs | `listeners.e2e.test.ts`, `tls.e2e.test.ts`, `outbound.e2e.test.ts`, `qa-logs.e2e.test.ts` (debug-log capture) |
| 10 | Retention deletes expired messages + attempts, keeps pending | `retention.e2e.test.ts`, `files.e2e.test.ts` |
| 11 | Graceful shutdown: in-flight messages never ACKed without being stored, none lost, and every stored message gets its ACK | `qa-gaps.e2e.test.ts` (d1 race, d2 deterministic) |
| 12 | UI: create channel → start → test send → live in the log → HL7/JSON detail → resend | `e2e/tests/ui-flow.spec.ts` |

Also covered: auth and the first-run wizard (`auth.e2e.test.ts`, `setup.e2e.test.ts`), SSE (`sse.e2e.test.ts`),
global log (`messages-global.e2e.test.ts`), metrics (`metrics.e2e.test.ts`), file transport (`files.e2e.test.ts`).

## 4. How to run

Node is not installed on the host; everything runs in containers.

```sh
# Unit + API e2e + web component tests + typecheck (Testcontainers needs the docker socket)
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD":/app -w /app node:22-alpine \
  sh -c "npm run build -w @ackwell/schemas && npx turbo run test typecheck"

# Playwright UI flow against a throwaway local stack (Postgres + API :3000 + Vite :5173 on the host network)
cd e2e
./local-stack.sh up && ./local-stack.sh test; ./local-stack.sh down

# The same flow against the live dev site (needs an existing Ackwell login; sign-up is disabled)
BASE_URL=https://ackwell.example.com QA_EMAIL=<email> QA_PASSWORD=<password> MLLP_PORT=6103 \
  ./local-stack.sh test
```

The Playwright run leaves `e2e/playwright-report/` and, on failure, traces/videos in `e2e/test-results/` (both git-ignored).
API e2e tests bind MLLP ports 6000–6050 on the host network (6001/6002 belong to Coolify and are avoided);
the local Playwright stack uses 6060–6070.

## 5. Entry / exit criteria

Entry: the suite is green on `main`, the dev site answers `/health` with `db: ok, queue: ok`.

Exit (ship): all must-cover scenarios have at least one automated test that passes; no open bug of severity
high or above; the Playwright flow passes against the local stack and, when a login is available, the live site;
the report in `docs/reports/` says *ship*.

## 6. Severity scale

- **critical** — data loss, message ACKed but not stored, secret exposure.
- **high** — a flow in §3 fails or a wrong ACK / status is recorded.
- **medium** — wrong UI state, missing validation, flaky retry.
- **low** — cosmetic, wording.

## 7. Known risks and gaps

- The live signed-in browser check (SSE through Cloudflare, Monaco) needs a user account; the suite is ready (`BASE_URL` run above).
- Scenario 2 with the database *down* (not just a failing insert) is not automated; a blocked insert is the closest deterministic equivalent.
- The real shared folder is not mounted on the host yet, so file transport is only tested with a temp folder.
- The inbound TLS private key is stored in clear in `channels.config` (follow-up from Phase 7); handshake failures are not logged.
