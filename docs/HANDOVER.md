# Ackwell — Handover

Read this first when you pick up the project (new session, new agent, or a new person).
It describes **where things stand right now**. Update it at the end of every work session.

**Last updated:** 2026-11-11 · **By:** main session
**Current phase:** Plan **APPROVED** 2026-11-11. Phase 1 (core) **done and LIVE on dev** (hot reload). Phase 1b (login) **done and live**. **Now: Phase 2 (inbound listeners).**
**Live (dev):** https://ackwell.joemarkgimeno.com (`curl -I` 200, `/health` ok, `/api/docs` 200). MLLP: `172.16.10.30:6100-6150` (LAN only).

---

## 1. Project in one paragraph
Ackwell is a full-stack app for HL7 v2 channels. An **inbound channel** is an MLLP server anyone on the LAN can send HL7 to: the message is saved, ACKed, parsed to lossless JSON and delivered through a pluggable adapter (signed webhook in v1). An **outbound channel** accepts JSON over REST (`POST /channels/:id/send`, API key), builds HL7, sends it over MLLP, waits for the ACK and records AA/AE/AR with retries. A shared message log, live viewer, test-send box and resend live in a React dashboard. Stack: NestJS + Drizzle + PostgreSQL + pg-boss (backend), React + Vite + TanStack + shadcn/ui + Monaco (frontend), npm workspaces + Turborepo monorepo, one Docker image, deployed through Coolify.

## 2. Key documents
| File | Purpose |
|---|---|
| `docs/PLAN.md` | full plan: how it works, stack, repo layout, data model, design decisions, deployment, build order |
| `docs/NEXT.md` | progress tracker and the next actions |
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
| Shared schemas (`packages/schemas`) | Zod 4 channel schemas (inbound/outbound config, webhook delivery, create/update/response) + port-range helper; built with tsup (ESM + CJS) |
| Backend (`apps/api`) | **Phase 1 done:** NestJS 12 (**ESM-only** → relative imports need `.js`), Zod-validated env, nestjs-pino, Swagger at `/api/docs`, `GET /health` (no `/api` prefix), Drizzle schema + migration `0000_init` (channels, messages, delivery_attempts, api_keys), migrations on startup (retries while the DB starts), channel CRUD `/api/channels` |
| Auth | Better Auth 1.7: email + password, sign-up disabled, global session guard (`@Public()` opt-out), first-run admin seed. Migration `0001_auth`. |
| Frontend (`apps/web`) | **Designed UI live:** shadcn/ui (radix-nova) + Tailwind 4 + React Router 8 + TanStack Query + RHF. Login, app shell (sidebar, status, theme), channels list, create/edit form (shared Zod schema), channel detail. Start/stop + messages are placeholders until Phase 2. Web tests 8/8. |
| Tests | schemas 7/7, API e2e (Vitest + Testcontainers Postgres) 12/12, typecheck clean, `nest build` + `vite build` OK |
| Dev compose | `docker-compose.yml`: one `node:22-alpine` container running `turbo dev` (vite :5173 proxies `/api` + `/health` to nest :3000). MLLP ports **not** published yet. |
| Coolify DB `ackwell-db` | uuid `zcukcdfdgfw5wveafh91vqwd`, Postgres 16, internal only, healthy. Daily backup 02:00, keep 14. |
| Coolify service `ackwell` | uuid `d3tdtacn0nqgdnanacqwv1pt`, hot reload, predefined network on, URL `https://ackwell.joemarkgimeno.com:5173`, env `DATABASE_URL` + `BETTER_AUTH_SECRET` set in Coolify. Container `app-d3tdtacn0nqgdnanacqwv1pt` publishes `172.16.10.30:6100-6150`. **LIVE.** |
| Git repo | `git init` on `main`, local commits only (no remote) |

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
2. **Git remote** (optional for dev; needed later for CI/auto-deploy of the production image).

## 5. Environment notes
- Node is **not** installed on the host. Run npm, drizzle-kit and tests in `node:22-alpine` containers.
- The Coolify API token comes from the `COOLIFY_API_TOKEN` env var. Never write it to a file.
- MLLP range **6100–6150** on `172.16.10.30` (env `MLLP_PORT_RANGE`, `MLLP_BIND_IP`).
- Debug: `docker logs app-d3tdtacn0nqgdnanacqwv1pt`. Restart: `POST /api/v1/services/d3tdtacn0nqgdnanacqwv1pt/restart`. A change to `turbo.json`, `package.json` deps or env vars needs a restart; source edits hot-reload.
- shadcn CLI quirk: `shadcn add` writes `import { cn } from "cn"` (an unrelated npm package). After adding a component, change it to `@/lib/utils`.
- Visual check: Playwright image `mcr.microsoft.com/playwright:v1.49.1-jammy` against the live URL (see session log 2026-11-11).
- Turbo 2 runs in strict env mode: any new env var the app reads must be added to `globalPassThroughEnv` in `turbo.json`, or it is invisible to the API.
- The first API token was resource-scoped and cannot create resources on the Coolify host; the admin token can. Neither is stored anywhere.
- Coolify project `dev-projects` (`t420hkorkdrbme5qjhltlq7m`), env `development` (`he4jwsjxdfhrgx8otyzubmov`). Resource name: `ackwell`.
- Hot-reload reference setup: `/root/project/react-test/`. Full multi-agent reference project: `/root/project/acemc-que/`.
- HL7 libraries: `node-hl7-client@latest`, `node-hl7-server@latest` (node-hl7 monorepo, Node 22+).

## 5b. Access (dev)
- Admin login: `admin@ackwell.local`. The password is env `SEED_ADMIN_PASSWORD` on the Coolify service `ackwell` (Dashboard → dev-projects → ackwell → Environment Variables). The seed runs only while no user exists; changing the env later does not change the password.

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
