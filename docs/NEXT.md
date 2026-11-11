# Ackwell — Next / Progress Tracker

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
Update this file whenever a task changes state. Each line gives its owner, and links to its report in `docs/reports/` once done.

**Now:** Phases 1, 1b, **2 (inbound), 5 (webhook delivery), 3 (outbound) and 6 (retention) done and LIVE** at https://ackwell.joemarkgimeno.com. **Phase 7 Hardening built and tested 2026-11-11 (SSE, global Messages page, Monaco, TLS, metrics) — live on dev; authenticated browser check of SSE/Messages/Monaco still pending (lead had no admin password). Next: Phase 8 QA, then Phase 9 production deployment (Dockerfile).**

---

## Up next (in order)
1. `[x]` Coolify `ackwell-db` + service `ackwell` created (admin token).
2. `[x]` Env vars set, deployed, verified: `curl -I` 200, `/health` ok, live CRUD smoke test.
3. `[x]` **backend-dev + frontend-dev:** Phase 1b — auth (Better Auth) so the public dev site is not open before listeners exist.
4. `[x]` **User:** MLLP host-port exception approved; senders use LAN IP `172.16.10.30`, range 6100–6150.
5. `[x]` **backend-dev:** Phase 2 — inbound listeners, message log API, UI wiring (2026-11-11, [report](reports/2026-11-11-backend-phase2-inbound.md)).
6. `[x]` **backend-dev:** Phase 5 — pg-boss, `DeliveryAdapter` + signed webhook, secrets, resend (2026-11-11, [report](reports/2026-11-11-backend-phase5-delivery.md)).
7. `[x]` **backend-dev:** Phase 3 — outbound send endpoint, API keys, strict-FIFO queue, MLLP sender, ACK tracking (2026-11-11, [report](reports/2026-11-11-backend-phase3-outbound.md)).
9. `[x]` **backend-dev:** Phase 6 — retention: hourly pg-boss schedule, batched deletes, protected statuses (2026-11-11, [report](reports/2026-11-11-backend-phase6-retention.md)).
10. `[x]` **backend-dev:** Phase 7 — `GET /api/events` (SSE from `AppEvents`), `GET /api/messages` (cross-channel log), TLS for inbound listeners + outbound CA, prom-client `/metrics` (done 2026-11-11, [report](reports/2026-11-11-backend-phase7-hardening.md)).
11. `[x]` **frontend-dev:** Phase 7 — SSE client replacing polling, **Messages** page, Monaco viewer, TLS form fields (2026-11-11, [report](reports/2026-11-11-frontend-phase7.md)).
12. `[~]` **lead:** HANDOVER/NEXT updated; API-side live smoke done (metrics, 401s, MLLP → ACK). **Pending:** signed-in browser check of `/messages`, SSE through Cloudflare and Monaco (needs the admin password or a browser session).
12b. `[x]` File transport (shared folder) built, tested and live on dev (2026-11-11, `docs/PLAN-FILE-TRANSPORT.md` → As built).
13. `[ ]` **qa-engineer:** Phase 8 — test plan, fixtures, must-cover scenarios, Playwright flow on the live site.

---

## Phase 0 — Planning & setup (owner: lead)
- [x] Read the server rules (`/root/project/CLAUDE.md`) and `docs/PLAN.md`
- [x] Create agents: backend-dev, frontend-dev, qa-engineer
- [x] Create `docs/HANDOVER.md` and `docs/NEXT.md`
- [x] User approves the plan (2026-11-11: hot reload, `ackwell`, Coolify DB)
- [x] MLLP ports: range 6100–6150 published on LAN IP 172.16.10.30 (approved 2026-11-11)
- [x] User answers HANDOVER §4b (Git remote done 2026-11-11: https://github.com/joemark0008/ackwell)
- [x] Check in Coolify that `ackwell` is free (no other resource uses the subdomain)
- [x] `git init` + `.gitignore` + `.env.example` (variables from PLAN → Environment variables)
- [x] Dev hot-reload `docker-compose.yml`
- [x] Coolify Postgres `ackwell-db` (daily backup 02:00, keep 14) + hot-reload service `ackwell`, deployed and live

## Phase 1 — Core (owner: backend-dev)
- [x] npm workspaces + Turborepo: `apps/api`, `apps/web`, `packages/schemas`
- [x] NestJS 12 (ESM) scaffold: config (Zod-validated env), nestjs-pino, Swagger at `/api/docs`, `GET /health`
- [x] Drizzle schema + first migration `0000_init`: `channels` (unique name, unique inbound port), `messages` (index on channel id + created at), `delivery_attempts`, `api_keys`; migrations on startup
- [x] pg-boss setup (done in Phase 5: `QueueService`, schema `pgboss`)
- [x] Zod channel config schemas in `packages/schemas` (inbound / outbound / webhook delivery; port range checked by the API)
- [x] Channel CRUD API `/api/channels` (400 VALIDATION_ERROR / PORT_OUT_OF_RANGE, 409 PORT_IN_USE / NAME_TAKEN / CHANNEL_RUNNING, 404 CHANNEL_NOT_FOUND)
- [x] Tests (Vitest + Testcontainers): CRUD, validation 400s, conflicts, migration on an empty DB — 12/12 + schemas 7/7
- [x] Placeholder web page (health + channel list) so the dev URL shows something
- [x] Built by main session (no agent report)

## Phase 1b — Auth before listeners (owner: backend-dev + frontend-dev)
> Brought forward from Hardening: the dev site is public, so the UI/API needs login before Phase 2 opens ports.
- [x] Better Auth 1.7 in NestJS (email + password, public sign-up disabled, sessions in Postgres, 12 h), mounted at `/api/auth/*` before the JSON parser; global `SessionGuard` on all routes, `@Public()` opt-out (used by `/health`; the API-key send endpoint will use it too)
- [x] Migration `0001_auth` (user, session, account, verification — generated with `@better-auth/cli`)
- [x] First admin user from env `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (only while the user table is empty)
- [x] First-run **setup wizard** (2026-11-11): when no users exist the API logs a one-time token; `/api/setup/{status,verify,complete}` (public), web gate shows the 3-step wizard, auto sign-in after creation; API e2e 7, web 2
- [x] Login page + session gate + sign-out in the web app
- [x] Tests: 401 without a session, wrong password 401, sign-up disabled, untrusted origin 403, login → API → logout → 401, seed runs once (API 19/19)
- [x] Live: sign-in, session, channels 200 / 401 without cookie, sign-out — verified 2026-11-11; user logged in

## Phase 2 — Inbound (owner: backend-dev) — DONE 2026-11-11
- [x] Channel manager: start/stop MLLP listeners at runtime (`POST /api/channels/:id/start|stop`); restore running channels on boot; close on shutdown
- [x] Pipeline: save raw HL7 (+ JSON, type, control id, sender IP) → ACK (AA / AE / AR); delivery job enqueued in the same transaction (Phase 5)
- [x] Generic lossless HL7 ↔ JSON codec in `packages/schemas/src/hl7.ts` (segments → fields → repeats → components → subcomponents, escapes kept, custom delimiters)
- [x] Round-trip tests on HL7 samples (schemas 14 tests) + MLLP e2e (API 8 tests with a raw MLLP client)
- [x] Message log API: `GET /api/channels/:id/messages` (cursor paging, status/q filters, total), `GET /api/messages/:id`
- [x] IP allowlist enforced on connect (brought forward from Hardening)
- [x] Report → [reports/2026-11-11-backend-phase2-inbound.md](reports/2026-11-11-backend-phase2-inbound.md)

## Phase 3 — Outbound (owner: backend-dev) — DONE 2026-11-11
- [x] `POST /channels/:id/send` (raw HL7 or generic JSON, Zod-validated; message row + job in one transaction; MSH-7/10/12 completed)
- [x] Worker with strict per-channel order (pg-boss `key_strict_fifo`, `singletonKey` = channel id): build HL7 → send over MLLP (raw `net`/`tls` sender, not node-hl7-client — socket leak) → await ACK → `sent` / `rejected`
- [x] Retry policy (`retry.maxAttempts`, fixed `retry.backoffSeconds`) + `delivery_attempts` with the raw ACK; AE/AR never retried; resend
- [x] Per-channel API keys (brought forward from Hardening): hashed, label, prefix, last used, revoke; Bearer auth on send
- [x] Tests against a raw MLLP receiver (outbound e2e 9)
- [x] Report → [reports/2026-11-11-backend-phase3-outbound.md](reports/2026-11-11-backend-phase3-outbound.md)

## Phase 4 — UI (owner: frontend-dev)
- [x] Vite + React + TS, Tailwind 4 + shadcn/ui (radix-nova, Geist + Geist Mono bundled, no CDN), TanStack Query, React Router 8, Vite dev proxy
- [x] Design: app shell (sidebar + mobile drawer, API/MLLP status, user menu, light/dark/system theme), teal brand + inbound/outbound/status tokens
- [x] Login (Better Auth) — split brand/form layout
- [x] Channels list (stats, direction tabs, search, table; card list on phones; empty state with inbound/outbound starters)
- [x] Create/edit forms (RHF + shared `createChannelSchema` resolver, server 400/409 mapped to fields, next-free-port suggestion, live "How it flows" preview, running-channel lock)
- [x] Channel detail (connection card with copyable MLLP address / send endpoint + curl, flow diagram, configuration, delete with confirm)
- [x] Start/stop wired (detail page button + list row menu, toasts, `PORT_UNAVAILABLE` / `CHANNEL_BUSY` messages)
- [x] Message log card (search by type / control id, status filter, cursor paging "Load older", 4 s polling while running) — SSE still `[ ]`
- [~] Message detail dialog: raw HL7 beside JSON (`<pre>` panes; Monaco `[ ]`), ACK, sender, attempts, resend `[x]`
- [x] Test-send box (outbound channel page; sends as the signed-in user)
- [x] Component tests (Vitest + Testing Library): form mapping 6, channels page 2, messages card 2, webhook card 2, API keys card 2
- [ ] Report → lead review

## Phase 5 — Delivery (owner: backend-dev) — DONE 2026-11-11
- [x] `DeliveryAdapter` interface + registry (`apps/api/src/delivery/delivery-adapter.ts`)
- [x] Webhook adapter: Standard Webhooks HMAC-SHA256 signing, two-secret rotation, pg-boss retries with exponential backoff, attempts recorded; `POST /api/messages/:id/resend`
- [x] Secret generation (32 random bytes, `whsec_`), returned once (create / rotate), shown once in the UI; secrets API (list hints, rotate, revoke) + webhook card
- [x] Tests: signature verify / tamper / replay window / rotation (unit 6) + delivery e2e 8 (signed delivery, backoff, maxAttempts, 4xx, rotation, revoke, no secret, resend)
- [x] Report → [reports/2026-11-11-backend-phase5-delivery.md](reports/2026-11-11-backend-phase5-delivery.md)

## Phase 6 — Retention (owner: backend-dev) — DONE 2026-11-11
- [x] Per-channel retention days (default from `RETENTION_DEFAULT_DAYS`) — since Phase 1; cutoff on `created_at`
- [x] Hourly pg-boss schedule (`0 * * * *` UTC, singleton queue), batched deletes of 1000, never deletes `received` / `queued` / `processing`; `GET /api/retention`, `POST /api/retention/run`
- [x] Tests: retention e2e 4 (cutoffs per channel, protected statuses, attempts cascade, 2,350-row batching, auth)
- [x] Report → [reports/2026-11-11-backend-phase6-retention.md](reports/2026-11-11-backend-phase6-retention.md)

## Phase 7 — Hardening (owner: backend-dev + frontend-dev) — DONE 2026-11-11 (browser check pending)
- [x] Per-channel API keys (hashed, label, last used, revoke) + UI (done in Phase 3)
- [x] IP allowlist on MLLP connect (done in Phase 2)
- [x] **SSE:** `GET /api/events[?channelId]` (session auth; `message` + `channel.status` events, `retry: 3000`, `: ping` every 15 s, listeners removed on disconnect); web `useLiveEvents` patches the TanStack caches, polls 4 s only while the stream is down, refetches lists after a reconnect
- [x] **Global message log:** `GET /api/messages` (channel-log filters + `channelId`, `direction`); web `/messages` page (shared `MessageLog` component, Channel column, channel/direction filters); sidebar "Messages" is a real link
- [x] **Monaco** in the message dialog (bundled locally, lazy chunk, `hl7` Monarch language, light/dark themes, JSON folding; side-by-side ≥ 1024 px, tabs below)
- [x] TLS for inbound listeners (`cert`/`key`/`ca`/`requestCert` PEM in config, key never returned, kept on update) and outbound (`ca`, `rejectUnauthorized` default false); form fields + detail card
- [x] Metrics (prom-client) at `GET /metrics` (optional `METRICS_TOKEN`): `ackwell_messages_total`, `ackwell_ack_failures_total`, `ackwell_queue_depth`, `ackwell_channel_status` + Node defaults; `/metrics` added to the Vite dev proxy
- [x] Tests: API SSE 5 + global list 5 + TLS 10 + metrics 7; schemas TLS/global-query cases; web live hook 7, Messages page 3, TLS form 6
- [x] Reports → [backend](reports/2026-11-11-backend-phase7-hardening.md), [frontend](reports/2026-11-11-frontend-phase7.md); HANDOVER §3/§7 + NEXT updated
- [ ] Signed-in browser check on the live site: `/messages` row appears on an MLLP send without reload (SSE through Cloudflare/Traefik), Monaco renders, no external (CDN) request in the network tab
- [ ] Follow-ups (not blocking): encrypt the inbound TLS private key at rest; log inbound TLS handshake failures

## Typed flat JSON — DONE 2026-11-11 (see `docs/HL7-TYPED-JSON.md`)
- [x] Generated types + runtime for HL7 2.3, 2.5.1, 2.7; send `{ flat }`; webhook `flat`; viewer switch; channel page note
- [ ] Later: more versions (2.4, 2.5, 2.6, 2.7.1 are in the dictionary; 2.8 needs another source) — steps in the doc
- [ ] Later: message-structure types (ADT_A01 groups), JSON Schema per version for webhook receivers

## File transport (shared folder) — DONE 2026-11-11 (see `docs/PLAN-FILE-TRANSPORT.md`)
- [x] Decided: 4 folders `ORDER` / `RESULT` / `PROCESSED` / `ERROR`, move to `PROCESSED`, one message per file
- [x] All questions answered (§9): any share mounted by the user at `FILE_ROOT`; configurable file name + separator; only finished .hl7 files (§3a: staged + rename out, stable + parse in); `.hl7` only; build before Phase 8
- [x] Schemas + migration (`transport`, `source_file`, `file_imports`), `FILE_ROOT` + path guard
- [x] Outbound `FileWriter` (atomic write) behind the existing outbound worker
- [x] Inbound `InboundFileWatcher` (chokidar 6, polling) in `ChannelManager` + import pipeline
- [x] UI: connection type switch, folder check, connection card, error files
- [x] Deployment: `/mnt/hl7share:/data/files:rslave` + `FILE_ROOT` on the Coolify service, migration live, health ok
- [ ] **User:** mount the real share on the host at `/mnt/hl7share`, then create a Shared-folder channel and try one file each way

## Phase 8 — QA (owner: qa-engineer)
- [ ] Test plan in `docs/qa/test-plan.md`
- [ ] HL7 fixtures in `fixtures/hl7/`
- [ ] All must-cover scenarios from `.claude/agents/qa-engineer.md`
- [ ] Playwright UI flow on the live dev site
- [ ] Bug list → fixes → retest → ship / no-ship

## Phase 9 — Deployment (owner: lead + backend-dev)
- [ ] Multi-stage `Dockerfile` (web + api in one image), migrations on start, graceful shutdown
- [ ] `docker-compose.yml` (app + optional postgres), `.env.example`
- [x] Coolify: Postgres `ackwell-db` (+ scheduled backups) in `dev-projects`
- [ ] Coolify: resource `ackwell` in `dev-projects` / `development`, domain `https://ackwell.joemarkgimeno.com`, env vars in Coolify
- [ ] MLLP port range 6100–6150 on 172.16.10.30 in the prod compose too (dev compose done)
- [ ] `curl -I https://ackwell.joemarkgimeno.com` → app (not 404/502); send a test HL7 message to a live listener
- [ ] Report the URL to the user
- [ ] Helm chart only if Kubernetes is needed

## Later
- [ ] NATS and other delivery adapters
- [ ] Per-channel mapping templates for friendly JSON
- [ ] Leader election for multiple replicas

## Done log
| Date | Item | Owner | Report |
|---|---|---|---|
| 2026-11-11 | `.claude/agents` (backend-dev, frontend-dev, qa-engineer), HANDOVER, NEXT | main session | — |
| 2026-11-11 | Plan approved; git init, monorepo, Phase 1 core (schemas, Drizzle, channel CRUD, health, Swagger), tests 19/19, dev compose | main session | — |
| 2026-11-11 | Coolify `ackwell-db` + hot-reload service deployed; live at https://ackwell.joemarkgimeno.com | main session | — |
| 2026-11-11 | Phase 1b: Better Auth login (API guard, admin seed, login page), live and verified | main session | — |
| 2026-11-11 | UI design: shadcn shell, channels list/form/detail, `/api/settings`; web tests 8/8, API 19/19; Playwright visual check desktop/mobile/dark on live | main session | — |
| 2026-11-11 | Phase 2: HL7↔JSON codec, channel manager + MLLP listeners, messages API, UI start/stop + message log + dialog; schemas 21/21, API 27/27, web 10/10; live MLLP smoke on 172.16.10.30:6100 | main session | [report](reports/2026-11-11-backend-phase2-inbound.md) |
| 2026-11-11 | Phase 5: pg-boss queue, DeliveryAdapter registry, signed webhook adapter (rotation, backoff), secrets API + UI, resend; API 41/41, web 12/12; live signed delivery verified | main session | [report](reports/2026-11-11-backend-phase5-delivery.md) |
| 2026-11-11 | Phase 3: send endpoint, API keys, strict-FIFO outbound queue, raw MLLP sender, ACK tracking, test-send + keys UI; API 50/50, web 14/14; live loopback sends verified | main session | [report](reports/2026-11-11-backend-phase3-outbound.md) |
| 2026-11-11 | First-run setup wizard (token in API log → create admin → signed in), brand assets + favicons, README | main session | — |
| 2026-11-11 | Phase 6: hourly retention schedule, batched deletes, protected statuses, status/run-now routes; API 54/54; live schedule verified | main session | [report](reports/2026-11-11-backend-phase6-retention.md) |
| 2026-11-11 | Phase 7: SSE `/api/events`, global `/api/messages` + Messages page, Monaco viewer, TLS listeners/outbound CA + form, `/metrics`; API 91/91, schemas 25/25, web 33/33; live: metrics + MLLP smoke `SSE0001` ok, browser check pending | backend-dev + frontend-dev | [backend](reports/2026-11-11-backend-phase7-hardening.md) · [frontend](reports/2026-11-11-frontend-phase7.md) |
