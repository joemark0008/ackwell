# Ackwell — Handover

Read this first when you pick up the project (new session, new agent, or a new person).
It describes **where things stand right now**. Update it at the end of every work session.

**Last updated:** 2026-11-11 · **By:** main session
**Current phase:** Plan **APPROVED** 2026-11-11. Phases 1, 1b, **2 (inbound), 5 (webhook delivery), 3 (outbound) and 6 (retention) done and LIVE on dev**. **Phase 7 Hardening (SSE, global Messages page, Monaco, TLS, metrics) built, tested and running on dev 2026-11-11; a signed-in browser check is still pending (see NEXT.md). Next: Phase 8 QA, then Phase 9 production deployment.**
**Live (dev):** https://ackwell.joemarkgimeno.com (`curl -I` 200, `/health` ok, `/api/docs` 200). MLLP: `172.16.10.30:6100-6150` (LAN only).

---

## 1. Project in one paragraph
Ackwell is a full-stack app for HL7 v2 channels. An **inbound channel** is an MLLP server anyone on the LAN can send HL7 to: the message is saved, ACKed, parsed to lossless JSON and delivered through a pluggable adapter (signed webhook in v1). An **outbound channel** accepts JSON over REST (`POST /channels/:id/send`, API key), builds HL7, sends it over MLLP, waits for the ACK and records AA/AE/AR with retries. A shared message log, live viewer, test-send box and resend live in a React dashboard. Stack: NestJS + Drizzle + PostgreSQL + pg-boss (backend), React + Vite + TanStack + shadcn/ui + Monaco (frontend), npm workspaces + Turborepo monorepo, one Docker image, deployed through Coolify.

## 2. Key documents
| File | Purpose |
|---|---|
| `README.md` | public readme: overview, local development, tests, HL7 try-out, deployment (dev hot-reload service + planned prod image), brand assets |
| `docs/PLAN.md` | full plan: how it works, stack, repo layout, data model, design decisions, deployment, build order |
| `docs/NEXT.md` | progress tracker and the next actions |
| `docs/PLAN-FILE-TRANSPORT.md` | file transport (shared-folder channels, chokidar) — **built**; read the *As built* section first |
| `docs/HL7-TYPED-JSON.md` | typed flat JSON: format rules, supported versions, API, **how to add a version** |
| `docs/HANDOVER.md` | this file — current state |
| `.claude/agents/*.md` | backend-dev, frontend-dev, qa-engineer |
| `docs/reports/` | agent reports (created when the first report is written) |
| `/root/project/CLAUDE.md` | server-wide Coolify deployment rules |

## 3. Current state
| Area | State |
|---|---|
| Plan (`docs/PLAN.md`) | **APPROVED** 2026-11-11 |
| `.claude` agents | Done: backend-dev, frontend-dev, qa-engineer |
| Monorepo | Done: npm workspaces + Turborepo (`apps/api`, `apps/web`, `packages/schemas`), Node 22, TypeScript 5.9 |
| Shared schemas (`packages/schemas`) | Zod 4 channel schemas (inbound/outbound config, webhook delivery, create/update/response) + port-range helper; **lossless HL7 ↔ JSON codec** (`hl7.ts`: `parseHl7` / `buildHl7`, browser-safe) + message schemas (`message.ts`) + webhook schemas (`webhook.ts`) + send/API-key schemas (`outbound.ts`); built with tsup (ESM + CJS) |
| Backend (`apps/api`) | **Phase 1 done:** NestJS 12 (**ESM-only** → relative imports need `.js`), Zod-validated env, nestjs-pino, Swagger at `/api/docs`, `GET /health` (no `/api` prefix), Drizzle schema + migration `0000_init` (channels, messages, delivery_attempts, api_keys), migrations on startup (retries while the DB starts), channel CRUD `/api/channels`. **Phase 2 done:** `ChannelManager` (MLLP listener per inbound channel via `node-hl7-server`, persist → ACK, allowlist, boot restore, shutdown close), `POST /api/channels/:id/start|stop`, `GET /api/channels/:id/messages` (keyset paging, filters), `GET /api/messages/:id`. Migration `0002_message_remote_address`. Report: `docs/reports/2026-11-11-backend-phase2-inbound.md`. **Phase 5 done:** pg-boss 12 (`QueueService`, schema `pgboss`), `DeliveryAdapter` + registry, webhook adapter (Standard Webhooks signing, two-secret rotation, backoff retries, attempts recorded), secrets API, `POST /api/messages/:id/resend`, `/health` reports `queue`. Migration `0003_webhook_secrets`. Report: `docs/reports/2026-11-11-backend-phase5-delivery.md`. **Phase 3 done:** `POST /api/channels/:id/send` (Bearer API key or session), per-channel API keys (SHA-256, shown once), queue `outbound` with pg-boss `key_strict_fifo` per channel, raw TCP/TLS MLLP sender with ACK timeout, AA→`sent` / AE,AR→`rejected` / transport→retries→`failed`, resend. Migration `0004_api_key_prefix`. Report: `docs/reports/2026-11-11-backend-phase3-outbound.md`. **Phase 6 done:** `RetentionService` (pg-boss schedule `0 * * * *` UTC, singleton queue, batched deletes of 1000, protected statuses `received`/`queued`/`processing`), `GET /api/retention`, `POST /api/retention/run`. Report: `docs/reports/2026-11-11-backend-phase6-retention.md`. **Phase 7 done:** `GET /api/events` SSE (`src/events/`), `GET /api/messages` (global log, `globalMessageListQuerySchema`), TLS inbound listeners (`cert`/`key`/`ca`/`requestCert`, key never returned, kept on update) + outbound `ca`/`rejectUnauthorized`, `GET /metrics` (`src/metrics/`, prom-client, optional `METRICS_TOKEN`). No migration. Report: `docs/reports/2026-11-11-backend-phase7-hardening.md` |
| Auth | Better Auth 1.7: email + password, sign-up disabled, global session guard (`@Public()` opt-out), first-run admin seed **or setup wizard** (2026-11-11: `SetupService` prints a one-time token to the log when no users exist; `GET /api/setup/status`, `POST /api/setup/verify|complete`; web `/` shows `SetupPage` until a user exists; token rotates on restart and after 5 misses). Migration `0001_auth`. |
| Frontend (`apps/web`) | **Designed UI live:** shadcn/ui (radix-nova) + Tailwind 4 + React Router 8 + TanStack Query + RHF. Login, app shell (sidebar, status, theme), channels list, create/edit form (shared Zod schema), channel detail. **Phase 2:** Start/Stop (detail + list menu), message log card (search, status filter, cursor paging, 4 s polling while running), message dialog (raw HL7 beside JSON; `<pre>` panes, Monaco later; **Resend** button). **Phase 5:** webhook card on inbound channels (active secrets, Generate/Rotate/Revoke), one-time secret dialog after create/rotate. **Phase 3:** outbound page has a test-send box and an API keys card (create → key shown once, revoke); Resend works for outbound. **Phase 7:** `lib/live.ts` (one `EventSource` on `/api/events`, patches TanStack caches, polling only as fallback, refetch after reconnect), `/messages` page (`pages/messages.tsx`, shared `components/message-log.tsx` with Channel column + channel/direction filters), Monaco viewer (`components/code-editor.tsx` lazy, `lib/monaco-setup.ts`: local workers, `hl7` language, light/dark themes), TLS fields in the channel form + detail card. Web tests 33/33. Report: `docs/reports/2026-11-11-frontend-phase7.md` |
| Tests | API e2e (Vitest + Testcontainers Postgres) **108/108** across 14 files (incl. files 16, SSE 5, global list 5, TLS 10, metrics 7; MLLP tests on ports 6040-6050), web **42/42**, schemas **53/53**, typecheck clean (2026-11-11, file transport) |
| Dev compose | `docker-compose.yml`: one `node:22-alpine` container running `turbo dev` (vite :5173 proxies `/api`, `/health` + `/metrics` to nest :3000). MLLP ports **not** published yet. |
| Coolify DB `ackwell-db` | uuid `zcukcdfdgfw5wveafh91vqwd`, Postgres 16, internal only, healthy. Daily backup 02:00, keep 14. |
| Coolify service `ackwell` | uuid `d3tdtacn0nqgdnanacqwv1pt`, hot reload, predefined network on, URL `https://ackwell.joemarkgimeno.com:5173`, env `DATABASE_URL` + `BETTER_AUTH_SECRET` set in Coolify. Container `app-d3tdtacn0nqgdnanacqwv1pt` publishes `172.16.10.30:6100-6150`. **LIVE.** |
| Git repo | `main` pushed to **https://github.com/joemark0008/ackwell** (remote `origin`, SSH, 2026-11-11). The server pushes with its own SSH key (`~/.ssh/id_ed25519`, added to the GitHub account). Commit only when the user asks. |

### Phase 2 facts (done 2026-11-11 — see the report for details)
- `node-hl7-server` 4.1.2: `createInbound` binds synchronously and emits `listen` / `error` (always attach `error`, or Node throws). `client.connect` fires before any data → allowlist rejects there. `data.raw` is emitted right before the handler with the exact frame. `Message.get('MSH.9')` returns only the first component, so the message type comes from our own codec.
- Listeners accept **any HL7 version** (`acceptAnyVersion`) so mismatched senders are logged, not silently AR'd.
- Persist-before-ACK: `MessagesService.recordInbound` inserts, then the listener sends the ACK code it returned (`AA`; `AE` if unparseable but stored; `AR` if the insert failed).
- Inbound messages are queued for delivery in the same transaction as the insert (pg-boss `fromDrizzle`). Status: `received` (queued) → `processing` (retrying) → `delivered` | `failed`.

### Phase 5 facts (done 2026-11-11 — see the report)
- Webhook secrets live in `webhook_secrets` in clear (needed to sign); returned once (`POST /channels` response `webhookSecret`, `…/webhook-secrets/rotate`), listed as 4-char hints, never logged. Channels created before Phase 5 (`Lab results in`) have **no secret** → the channel page warns and offers *Generate secret*; deliveries fail until then.
- Signing: Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<b64 HMAC-SHA256 of id.ts.body>`); two signatures during a rotation. Receiver reference: `apps/api/src/delivery/standard-webhooks.ts` `verify()`; a Node snippet is shown in the secret dialog.
- Retries: pg-boss per-job `retryLimit = maxAttempts − 1`, exponential backoff from `DELIVERY_RETRY_DELAY_SECONDS` (10 s, cap 10 min); 4xx (except 408/429) is permanent. Each try → `delivery_attempts`. Resend continues the attempt numbering.
- `AppEvents` (`src/common/events.ts`) emits `message` and `channel.status` — the SSE source for later.

### Phase 3 facts (done 2026-11-11 — see the report)
- Send body: `{ "hl7": "MSH|…" }` (raw, `\r` or `\n` between segments) or the generic `{ "segments": [...] }`. Empty MSH-7 / MSH-10 / MSH-12 are filled (`completeHeader` in `outbound.service.ts`). The channel must be `running` (409 `CHANNEL_STOPPED`).
- Auth: `Authorization: Bearer ak_…` (key of that channel) or a session. Keys: `api_keys` (SHA-256 + 11-char prefix), create/list/revoke under `/api/channels/:id/api-keys`.
- **Sending uses a raw `net`/`tls` socket** (`src/outbound/mllp-sender.ts`), not node-hl7-client: on 4.1.2 the client opened two sockets per connection and `close()` left them open (probe in the report). TLS uses `rejectUnauthorized: false`.
- Ordering: pg-boss queue `outbound`, policy `key_strict_fifo`, `singletonKey` = channel id. **A job left in pg-boss `failed` state blocks that channel's key**, so the worker always completes a job when it gives up (message status `failed`), never throws on the last try. Retries: fixed `retry.backoffSeconds`, `retry.maxAttempts` total tries. AE/AR are not retried.
- `ensureQueue` must not pass `policy` for an existing queue (pg-boss: "queue policy cannot be changed after creation").
- The user's `Orders to LIS` targets `172.16.12.91:22222` (their machine); loopback smoke used temporary channels on 6102, deleted afterwards.

### Phase 6 facts (done 2026-11-11 — see the report)
- Retention runs hourly (`0 * * * *` UTC) through pg-boss schedule `retention` (singleton queue) and on demand via `POST /api/retention/run`; `GET /api/retention` shows cron, next run and the last run (in memory). Cutoff = `now − channel.retentionDays` on `created_at`; `received` / `queued` / `processing` are never deleted; batches of 1000 per channel; attempts cascade.
- Live sample: channel `Lab results in` (`661a50b5…`) is **running on 6100**; a smoke message `LIVE0001` from `172.16.10.30` is in its log. Smoke sender: a 20-line Python MLLP client (see session log).

### Phase 7 facts (done 2026-11-11 — see both reports)
- **SSE:** `GET /api/events[?channelId]` behind the session guard; `event: message` (MessageSummary, every create/status change incl. `processing`) and `event: channel.status`; prelude `retry: 3000`, `: ping` every 15 s, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. No replay after a reconnect → the web hook invalidates the channel and message lists when it reconnects. Polling (4 s) only runs while the stream is not `live`.
- **Global log:** `GET /api/messages` shares the query builder with the channel log; same `MessageList` shape. Web key `['messages','all',filters]`.
- **TLS:** inbound `config.tls = {enabled, cert?, key?, ca?, requestCert}` (PEM, `cert`+`key` required when enabled, `ca` required with `requestCert`); responses return `hasKey` instead of `key`; PATCH keeps the stored key when `key` is omitted but `cert`/`ca` must be re-sent (the form prefills them). Outbound `config.tls = {enabled, ca?, rejectUnauthorized}` (default false = accepts self-signed, as before). The inbound private key is stored in plaintext in `channels.config` (follow-up: encrypt at rest). Handshake failures are not logged. Test-only certs in `apps/api/test/fixtures/`.
- **Metrics:** `GET /metrics` is public unless `METRICS_TOKEN` (≥ 16 chars) is set (then `Authorization: Bearer`). Series `ackwell_messages_total{channel_id,channel_name,direction,status}` (received/delivered/sent/rejected/failed, deduped), `ackwell_ack_failures_total`, `ackwell_queue_depth{queue}` and `ackwell_channel_status` computed on scrape, plus Node defaults.
- **Monaco** is bundled locally (no CDN): main chunk unchanged (~1.1 MB / 326 kB gzip); the lazy editor chunk (~3 MB / 770 kB gzip + JSON mode + 2 workers + codicon font) loads only when a message dialog opens. The string `cdn.jsdelivr` exists in the chunk from the loader's default config but is unused because `loader.config({ monaco })` is set — confirm once in the browser network tab.
- **Live smoke (API side, 2026-11-11):** `/metrics` through the proxy returns the `ackwell_*` series; `/api/events` and `/api/messages` return 401 without a session; MLLP `SSE0001` to `Lab results in` on 6100 → `MSA|AA`, received and delivered. The signed-in checks (Messages page updates live, Monaco renders, no external requests) are **not done**: `SEED_ADMIN_PASSWORD` is no longer in the container env and the lead had no Coolify token, so no session could be obtained.

### Typed flat JSON (done 2026-11-11)
- `packages/schemas/src/hl7-flat/`: typed flat format per HL7 version (2.3, 2.5.1, 2.7). Keys `pid_5_1_1`; MSH keys at top level; `msh_12` (always, even when MSH-12 is a VID composite) is the version discriminant; other segments in order in `segments[]` tagged `segment: 'PID'`; repeating fields are arrays; Z-segments stay positional `{ segment, fields }`; anything off-spec goes to the segment's `_extra` as raw text (lossless apart from trailing empties).
- API: `toFlat` / `tryToFlat` / `fromFlat` / `flatToHl7` / `validateFlat` / `hl7FlatSchema` / `escapeHl7` / `segmentOf(s)`; types `Hl7Flat`, `Hl7Flat_2_7`, namespaces `Hl7v2_7.PID` etc.
- `generated/v*.ts` are written by `npm run gen:hl7-flat -w @ackwell/schemas` from the devDependency `hl7-dictionary@1.0.1` (MIT). Don't edit them by hand; corrections go in `FIELD_OVERRIDES` in `scripts/gen-hl7-flat.mjs` (OBX-5 → VARIES, repeating).
- Wired in: `POST /channels/:id/send` accepts `{ flat }`; webhook payloads carry `flat` (null for other versions or undefined non-Z segments); message viewer has a Typed/Lossless switch; channel page Configuration shows a "Typed JSON" row (reads `HL7_FLAT_VERSIONS`). Full reference and the add-a-version steps: `docs/HL7-TYPED-JSON.md`.

### File transport (done 2026-11-11 — see `docs/PLAN-FILE-TRANSPORT.md`, As built)
- Channels have `transport: 'mllp' | 'file'`; bodies without it mean `mllp`. File channels need `FILE_ROOT` (else `FILES_DISABLED`).
- Folders are relative to `FILE_ROOT` (dev: `/data/files` ← host `/mnt/hl7share`, `rslave`). Defaults `ORDER` (out), `RESULT` → `PROCESSED` / `ERROR` (in). Staging: `FILE_ROOT/.ackwell-tmp`.
- Code: `apps/api/src/files/` (root guard, writer, chokidar watcher), `channels/file-import.service.ts`, `channels/files.service.ts`; outbound worker branches on `transport`. Web: `components/file-fields.tsx`, `components/file-errors-card.tsx`.
- **New env vars must be added to `globalPassThroughEnv` in `turbo.json`**, or `turbo dev` hides them from the API (this is why `FILE_ROOT` first showed "Not available" in the UI).
- The real share is **not mounted yet**: `/mnt/hl7share` is an empty local folder until the user mounts it.

### How to run tests (Node is not on the host)
```
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/project/ackwell:/app -w /app node:22-alpine \
  sh -c "npm run build -w @ackwell/schemas && npx turbo run test typecheck"
```
New migration after a schema change: `cd apps/api && npx drizzle-kit generate --name <change>` (in the container).

## 4. Decisions already made (from PLAN.md)
- Generic, lossless JSON (segments → fields → components); friendly per-channel mappings later.
- Persist before ACK. pg-boss on the same Postgres (no Redis). One queue per outbound channel for ordering.
- Delivery via a `DeliveryAdapter` interface; webhook only in v1, signed per Standard Webhooks with secret rotation.
- No encryption at rest (LAN only). Retention per channel, default 7 days, hourly cleanup job.
- Security: per-channel IP allowlist + optional TLS for MLLP; hashed per-channel API keys for the send endpoint; Better Auth for the UI.
- Single replica (listeners own ports). MLLP port range 6100–6150 (PLAN said 6000–6050; changed, see below).
- One image: NestJS serves the built SPA.

## 4a. User decisions (2026-11-11)
- Plan approved. Dev runs in **live hot reload** mode. Subdomain **`ackwell`**. Database = **Coolify-managed Postgres** `ackwell-db`.

- **MLLP ports (2026-11-11):** publishing the MLLP range on the host is approved for `ackwell` (exception to `/root/project/CLAUDE.md` §2). Senders use the machine's **LAN IP `172.16.10.30`**, not the Cloudflare domain. The range is **6100–6150**, not 6000–6050, because Coolify itself listens on 6001–6002. Bound to the LAN IP only (`MLLP_BIND_IP`).

## 4b. Open items for the user
1. ~~Coolify admin action~~ — done 2026-11-11 with an admin token (DB + service created via API).
2. ~~Git remote~~ — done 2026-11-11: https://github.com/joemark0008/ackwell (see §3). CI/auto-deploy of the production image can use it later.

## 5. Environment notes
- Node is **not** installed on the host. Run npm, drizzle-kit and tests in `node:22-alpine` containers.
- The Coolify API token comes from the `COOLIFY_API_TOKEN` env var. Never write it to a file.
- MLLP range **6100–6150** on `172.16.10.30` (env `MLLP_PORT_RANGE`, `MLLP_BIND_IP`).
- **Watcher quirk (2026-11-11):** running the test container's `npm run build -w @ackwell/schemas` while the dev service is up rewrites `packages/schemas/dist` under the running `nest --watch`; tsc then caches "Could not find a declaration file for '@ackwell/schemas'" (25 errors) and stops restarting the API on edits even though the d.ts is back. Only a service restart clears it. Avoid by skipping the schemas build in the test container (tsup --watch in the dev container already keeps dist current) or restart after testing.
- Debug: `docker logs app-d3tdtacn0nqgdnanacqwv1pt`. Restart: `POST /api/v1/services/d3tdtacn0nqgdnanacqwv1pt/restart`. A change to `turbo.json`, `package.json` deps or env vars needs a restart; source edits hot-reload.
- shadcn CLI quirk: `shadcn add` writes `import { cn } from "cn"` (an unrelated npm package). After adding a component, change it to `@/lib/utils`.
- Visual check: Playwright image `mcr.microsoft.com/playwright:v1.49.1-jammy` against the live URL (see session log 2026-11-11).
- Turbo 2 runs in strict env mode: any new env var the app reads must be added to `globalPassThroughEnv` in `turbo.json`, or it is invisible to the API.
- pg-boss keeps its tables in schema `pgboss` of `ackwell-db` (created on first start, not a Drizzle migration). Queue `delivery`. Jobs are deleted 7 days after completion.
- **Dev container `node_modules` is a named volume**, separate from the host's `node_modules`. After adding a dependency, run `docker exec app-d3tdtacn0nqgdnanacqwv1pt npm install` (or restart the service) — an `npm install` from an outside `docker run` only fills the host copy. Running `tsup --clean` on `packages/schemas` from outside also leaves the in-container `nest --watch` with stale module resolution ("Could not find a declaration file for '@ackwell/schemas'") until the container restarts. Restart = Coolify dashboard → ackwell → Restart (or `POST /api/v1/services/<uuid>/restart` with the token; `docker restart app-…` was used on 2026-11-11 when no token was in the session).
- The first API token was resource-scoped and cannot create resources on the Coolify host; the admin token can. Neither is stored anywhere.
- Coolify project `dev-projects` (`t420hkorkdrbme5qjhltlq7m`), env `development` (`he4jwsjxdfhrgx8otyzubmov`). Resource name: `ackwell`.
- Hot-reload reference setup: `/root/project/react-test/`. Full multi-agent reference project: `/root/project/acemc-que/`.
- HL7 libraries: `node-hl7-client@latest`, `node-hl7-server@latest` (node-hl7 monorepo, Node 22+).

## 5b. Access (dev)
- Admin login: created by the user through the **setup wizard** (`/setup`), not the env seed. On 2026-11-11 the user forgot the password; at their request the only user (their own email) was deleted from the `user` table (sessions/accounts cascade) and the service restarted so the wizard came back. The password is known only to the user, and only a hash is stored. For signed-in live checks, ask the user for a session or a test account (do not mint sessions in the DB).
- Setup status is read at startup: after deleting all users, restart the service (Coolify API restart) to get `{"needed":true}` and a fresh token in the API log.

## 6. Known issues / risks
- MLLP traffic bypasses the reverse proxy and Cloudflare: senders use `172.16.10.30:6100-6150`. The host firewall (ufw) is inactive; the machine only has a private IP, so the ports are reachable from the LAN (172.16.10.0/25 and routed internal networks) only, unless a router forwards them. If the LAN IP changes, update `MLLP_BIND_IP` or the container will fail to start — a DHCP reservation / static IP is recommended.
- Raw HL7 (patient data) is stored unencrypted — acceptable only while the app stays on the LAN.
- The dev UI/API is on the public internet behind login. `/api/docs` (Swagger page) is public but every API call needs a session. Cookie-authenticated API routes rely on `SameSite=Lax` for CSRF; Better Auth's own routes also check Origin.
- `turbo dev`: the API reads `@ackwell/schemas` from its built `dist/`; tsup rebuilds on change, but nest watch may need a save in `apps/api` to pick it up.
- Strict outbound ordering with pg-boss needs the right queue policy; confirm during Phase 3.
- `node-hl7-server` / `node-hl7-client` APIs must be checked against their current docs before building.

## 7. Session log
| Date | Who | What happened |
|---|---|---|
| 2026-11-11 | main session | Read server rules + PLAN. Created `.claude/agents/` (backend-dev, frontend-dev, qa-engineer), `docs/HANDOVER.md`, `docs/NEXT.md`. Listed open questions (§4b). Waiting for plan approval. |
| 2026-11-11 | main session | User approved plan (hot reload, `ackwell`, Coolify DB). git init, monorepo scaffold, Phase 1 core built + tested (schemas 7/7, API e2e 12/12). Dev compose written. Coolify DB/service creation **blocked**: token not admin. Subdomain `ackwell` verified free. |
| 2026-11-11 | main session | User approved publishing the MLLP range on the LAN IP. Coolify uses 6001–6002, so the range moved to **6100–6150** on `172.16.10.30` (compose + env default + .env.example). |
| 2026-11-11 | main session | Created Coolify `ackwell-db` (+ daily backup) and hot-reload service `ackwell` via API (admin token), set env vars, deployed. Fixed Turbo strict-env filtering of `DATABASE_URL` (`globalPassThroughEnv`). Live checks: `curl -I` 200, `/health` ok, CRUD smoke test (create, 400 out-of-range, delete) on the live URL. |
| 2026-11-11 | main session | Phase 1b: Better Auth (guard, admin seed, login page). Tests 19/19. Seed env added in Coolify (password only there), service restarted, user confirmed login on the live site. |
| 2026-11-11 | main session | UI designed and built (shadcn shell, channels list/form/detail, login), `GET /api/settings` (MLLP host + range). Playwright visual pass on live (desktop, mobile 390 px, dark); fixed mobile table clipping + outbound code block. Two sample channels created on dev (`Lab results in`, `Orders to LIS`). |
| 2026-11-11 | main session | Phase 2 started: HL7 libraries installed and their API checked (notes in §3). Stopped at the usage limit before writing Phase 2 code. |
| 2026-11-11 | main session + backend-dev + frontend-dev | **Phase 7 built and tested, running on dev.** Backend agent: SSE `/api/events`, global `/api/messages`, TLS listeners + outbound CA, `/metrics` (API 91/91, schemas 25/25). Frontend agent: live hook replacing polling, `/messages` page, Monaco viewer, TLS form follow-up (web 33/33). Lead: deps installed in the dev container up front, `/metrics` added to the Vite proxy, container restarted once (stale schema types), API-side live smoke ok (metrics series, 401s, MLLP `SSE0001` → AA). **Not done:** signed-in browser check (no admin password available; DB access for minting a session was denied by the tool policy). Reports `docs/reports/2026-11-11-backend-phase7-hardening.md`, `docs/reports/2026-11-11-frontend-phase7.md`. Committed as `2c33f1d` (user asked), not pushed. |
| 2026-11-11 | main session | **Phase 6 built, tested and live.** Hourly retention job (pg-boss schedule, batched deletes, protected statuses), status + run-now routes. API 54/54. Container restarted once (stale schema types). Live: schedule registered, next run 06:00 UTC, manual run → 0 deleted. Phase 3 committed as `71599ac` (user asked). Report `docs/reports/2026-11-11-backend-phase6-retention.md`. |
| 2026-11-11 | main session | **Phase 3 built, tested and live.** Send endpoint + API keys + strict-FIFO outbound queue + raw MLLP sender + ACK tracking; UI test-send + API keys. node-hl7-client dropped for sending (socket leak). API 50/50, web 14/14. Container restarted once (stale schema types). Live loopback: 3 sends via Bearer key → `sent`/AA in order. Phase 5 committed as `6bd567b` (user asked). Report `docs/reports/2026-11-11-backend-phase3-outbound.md`. |
| 2026-11-11 | main session | **Phase 5 built, tested and live.** pg-boss queue, `DeliveryAdapter` registry, signed webhook adapter with rotation + backoff retries, secrets API/UI, resend. API 41/41, web 12/12. Container `npm install` + restart for pg-boss. Live smoke: in-container receiver, temp channel on 6101 → `delivered`, signature verified, channel deleted. Report `docs/reports/2026-11-11-backend-phase5-delivery.md`. Phase 2 committed as `2a86ea7` (user asked). |
| 2026-11-11 | main session | **Phase 2 built, tested and live.** HL7↔JSON codec + message schemas (schemas 21/21), `ChannelManager` + listener + messages API (API 27/27), UI Start/Stop + message log + dialog (web 10/10). Dev container needed an in-container `npm install` + restart (node_modules volume). Live smoke: started `Lab results in` on 6100, MLLP from `172.16.10.30` → `MSA|AA|LIVE0001`, message visible in API + UI. Playwright pass on detail/dialog/list (desktop, mobile, dark). Report `docs/reports/2026-11-11-backend-phase2-inbound.md`. |
| 2026-11-11 | main session | **File transport built, tested and live (user AFK, per plan).** Shared-folder channels: atomic outbound writes into `ORDER`, chokidar pickup from `RESULT` → `PROCESSED` / `ERROR` (+ `.error.txt`, Retry), duplicates by sha256, retention of `PROCESSED`, UI connection type + error files card. Migration `0005_file_transport`. Schemas 53/53, API 108/108, web 42/42, typecheck clean. Coolify compose: `FILE_ROOT=/data/files` + `/mnt/hl7share:/data/files:rslave`; service restarted (chokidar installed by the start command), migration applied, `/health` ok. Not committed. |
| 2026-11-11 | main session | **Typed flat JSON built, tested and live.** Generated per-version types/runtime for HL7 2.3, 2.5.1, 2.7 (`packages/schemas/src/hl7-flat/`, generator from `hl7-dictionary`), send `{ flat }`, webhook `flat`, viewer Typed/Lossless switch, channel-page "Typed JSON" row, `docs/HL7-TYPED-JSON.md`. Schemas 45/45, API 92/92, web 36/36, typecheck clean. Also: at the user's request the only admin user was deleted and the service restarted so `/setup` came back; the user completed setup again. |
