# Ackwell — Next / Progress Tracker

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
Update this file whenever a task changes state. Each line gives its owner, and links to its report in `docs/reports/` once done.

**Now:** Phases 1, 1b and **2 (inbound listeners) done and LIVE** at https://ackwell.joemarkgimeno.com. **Next: Phase 3 (outbound send + worker) — then Phase 5 (webhook delivery) so inbound messages leave `received`.**

---

## Up next (in order)
1. `[x]` Coolify `ackwell-db` + service `ackwell` created (admin token).
2. `[x]` Env vars set, deployed, verified: `curl -I` 200, `/health` ok, live CRUD smoke test.
3. `[x]` **backend-dev + frontend-dev:** Phase 1b — auth (Better Auth) so the public dev site is not open before listeners exist.
4. `[x]` **User:** MLLP host-port exception approved; senders use LAN IP `172.16.10.30`, range 6100–6150.
5. `[x]` **backend-dev:** Phase 2 — inbound listeners, message log API, UI wiring (2026-11-11, [report](reports/2026-11-11-backend-phase2-inbound.md)).
6. `[ ]` **backend-dev:** Phase 3 — outbound: pg-boss setup, `POST /channels/:id/send` (API key), per-channel worker with `node-hl7-client`, ACK tracking + retries.
7. `[ ]` **backend-dev:** Phase 5 — `DeliveryAdapter` + signed webhook so inbound messages are delivered.
8. `[ ]` **frontend-dev:** SSE live feed (replace 4 s polling), Monaco in the message dialog, test-send box, resend.

---

## Phase 0 — Planning & setup (owner: lead)
- [x] Read the server rules (`/root/project/CLAUDE.md`) and `docs/PLAN.md`
- [x] Create agents: backend-dev, frontend-dev, qa-engineer
- [x] Create `docs/HANDOVER.md` and `docs/NEXT.md`
- [x] User approves the plan (2026-11-11: hot reload, `ackwell`, Coolify DB)
- [x] MLLP ports: range 6100–6150 published on LAN IP 172.16.10.30 (approved 2026-11-11)
- [x] User answers HANDOVER §4b (Git remote optional, still open)
- [x] Check in Coolify that `ackwell` is free (no other resource uses the subdomain)
- [x] `git init` + `.gitignore` + `.env.example` (variables from PLAN → Environment variables)
- [x] Dev hot-reload `docker-compose.yml`
- [x] Coolify Postgres `ackwell-db` (daily backup 02:00, keep 14) + hot-reload service `ackwell`, deployed and live

## Phase 1 — Core (owner: backend-dev)
- [x] npm workspaces + Turborepo: `apps/api`, `apps/web`, `packages/schemas`
- [x] NestJS 12 (ESM) scaffold: config (Zod-validated env), nestjs-pino, Swagger at `/api/docs`, `GET /health`
- [x] Drizzle schema + first migration `0000_init`: `channels` (unique name, unique inbound port), `messages` (index on channel id + created at), `delivery_attempts`, `api_keys`; migrations on startup
- [ ] pg-boss setup (moved to Phase 2/3 where the first queue is used)
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
- [x] Login page + session gate + sign-out in the web app
- [x] Tests: 401 without a session, wrong password 401, sign-up disabled, untrusted origin 403, login → API → logout → 401, seed runs once (API 19/19)
- [x] Live: sign-in, session, channels 200 / 401 without cookie, sign-out — verified 2026-11-11; user logged in

## Phase 2 — Inbound (owner: backend-dev) — DONE 2026-11-11
- [x] Channel manager: start/stop MLLP listeners at runtime (`POST /api/channels/:id/start|stop`); restore running channels on boot; close on shutdown
- [x] Pipeline: save raw HL7 (+ JSON, type, control id, sender IP) → ACK (AA / AE / AR). Enqueue delivery → Phase 5 (no pg-boss yet; messages stay `received`)
- [x] Generic lossless HL7 ↔ JSON codec in `packages/schemas/src/hl7.ts` (segments → fields → repeats → components → subcomponents, escapes kept, custom delimiters)
- [x] Round-trip tests on HL7 samples (schemas 14 tests) + MLLP e2e (API 8 tests with a raw MLLP client)
- [x] Message log API: `GET /api/channels/:id/messages` (cursor paging, status/q filters, total), `GET /api/messages/:id`
- [x] IP allowlist enforced on connect (brought forward from Hardening)
- [x] Report → [reports/2026-11-11-backend-phase2-inbound.md](reports/2026-11-11-backend-phase2-inbound.md)

## Phase 3 — Outbound (owner: backend-dev)
- [ ] `POST /channels/:id/send` (Zod-validated JSON, enqueue)
- [ ] pg-boss worker per channel (strict order): build HL7 → send → await ACK → record AA/AE/AR
- [ ] Retry policy + `delivery_attempts`; confirm the queue policy for ordering
- [ ] Tests against a mock MLLP receiver
- [ ] Report → lead review

## Phase 4 — UI (owner: frontend-dev)
- [x] Vite + React + TS, Tailwind 4 + shadcn/ui (radix-nova, Geist + Geist Mono bundled, no CDN), TanStack Query, React Router 8, Vite dev proxy
- [x] Design: app shell (sidebar + mobile drawer, API/MLLP status, user menu, light/dark/system theme), teal brand + inbound/outbound/status tokens
- [x] Login (Better Auth) — split brand/form layout
- [x] Channels list (stats, direction tabs, search, table; card list on phones; empty state with inbound/outbound starters)
- [x] Create/edit forms (RHF + shared `createChannelSchema` resolver, server 400/409 mapped to fields, next-free-port suggestion, live "How it flows" preview, running-channel lock)
- [x] Channel detail (connection card with copyable MLLP address / send endpoint + curl, flow diagram, configuration, delete with confirm)
- [x] Start/stop wired (detail page button + list row menu, toasts, `PORT_UNAVAILABLE` / `CHANNEL_BUSY` messages)
- [x] Message log card (search by type / control id, status filter, cursor paging "Load older", 4 s polling while running) — SSE still `[ ]`
- [~] Message detail dialog: raw HL7 beside JSON (`<pre>` panes; Monaco `[ ]`), ACK, sender, attempts; resend `[ ]`
- [ ] Test-send box
- [x] Component tests (Vitest + Testing Library): form mapping 6, channels page 2, messages card 2
- [ ] Report → lead review

## Phase 5 — Delivery (owner: backend-dev)
- [ ] `DeliveryAdapter` interface + registry
- [ ] Webhook adapter: Standard Webhooks HMAC-SHA256 signing, two-secret rotation, retries with backoff
- [ ] Secret generation (32 random bytes), shown once in the UI (frontend-dev)
- [ ] Tests: signature verify, tamper, replay window, rotation, retries
- [ ] Report → lead review

## Phase 6 — Retention (owner: backend-dev)
- [ ] Per-channel retention days (default from `RETENTION_DEFAULT_DAYS`)
- [ ] Hourly pg-boss job, batched deletes, skips pending/retrying messages
- [ ] Tests

## Phase 7 — Hardening (owner: backend-dev + frontend-dev)
- [ ] Per-channel API keys (hashed, label, last used, revoke) + UI
- [x] IP allowlist on MLLP connect (done in Phase 2)
- [ ] TLS for inbound listeners and outbound connections
- [ ] Metrics (prom-client): messages/min, ACK failures, queue depth
- [ ] SSE for channel status + live feed (if not done in Phase 4)

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
