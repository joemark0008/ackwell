# Ackwell — Next / Progress Tracker

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
Update this file whenever a task changes state. Each line gives its owner, and links to its report in `docs/reports/` once done.

**Now:** Plan approved 2026-11-11. Phase 1 (core) **done locally** (tests green). **LIVE** on dev at https://ackwell.joemarkgimeno.com (hot reload). **Up next: Phase 1b (login).**

---

## Up next (in order)
1. `[x]` Coolify `ackwell-db` + service `ackwell` created (admin token).
2. `[x]` Env vars set, deployed, verified: `curl -I` 200, `/health` ok, live CRUD smoke test.
3. `[ ]` **backend-dev + frontend-dev:** Phase 1b — auth (Better Auth) so the public dev site is not open before listeners exist.
4. `[x]` **User:** MLLP host-port exception approved; senders use LAN IP `172.16.10.30`, range 6100–6150.
5. `[ ]` **backend-dev:** Phase 2 — inbound listeners.

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
- [ ] Better Auth in NestJS (email + password, sessions in Postgres), guard on all `/api/*` except `/health` and the future API-key send endpoint
- [ ] First admin user from env (seed once)
- [ ] Login page + auth guard in the web app
- [ ] Tests: 401 without a session, login/logout

## Phase 2 — Inbound (owner: backend-dev)
- [ ] Channel manager: start/stop/restart MLLP listeners at runtime; restore running channels on boot
- [ ] Pipeline: save raw HL7 → ACK → parse to lossless JSON → enqueue delivery
- [ ] Generic HL7 ↔ JSON converter (segments → fields → components, escapes, repeats)
- [ ] Round-trip tests on real HL7 samples
- [ ] Report → lead review

## Phase 3 — Outbound (owner: backend-dev)
- [ ] `POST /channels/:id/send` (Zod-validated JSON, enqueue)
- [ ] pg-boss worker per channel (strict order): build HL7 → send → await ACK → record AA/AE/AR
- [ ] Retry policy + `delivery_attempts`; confirm the queue policy for ordering
- [ ] Tests against a mock MLLP receiver
- [ ] Report → lead review

## Phase 4 — UI (owner: frontend-dev)
- [ ] Vite + React + TS, Tailwind + shadcn/ui, TanStack Query, router, Vite dev proxy
- [ ] Login (Better Auth)
- [ ] Channels list + create/edit forms (RHF + shared Zod) + start/stop
- [ ] Message log (TanStack Table, filters, server paging, live via SSE)
- [ ] Message detail: Monaco HL7/JSON side by side, ACK, attempts, resend
- [ ] Test-send box
- [ ] Component tests (Vitest)
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
- [ ] IP allowlist on MLLP connect
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
