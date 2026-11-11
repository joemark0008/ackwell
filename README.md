<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/ackwell-logo-dark.svg">
    <img src="apps/web/public/brand/ackwell-logo.svg" alt="Ackwell" width="218" height="64">
  </picture>
</p>

<p align="center"><b>HL7 v2 channels.</b> MLLP in, lossless JSON out, signed webhooks, and JSON back to HL7 over MLLP with ACK tracking.</p>

---

Ackwell is a small integration engine for HL7 v2 with a web dashboard.

- **Inbound channel** - an MLLP listener on a port you choose. Every message is stored first, then ACKed (`AA` / `AE` / `AR`), parsed to lossless JSON and delivered to a signed webhook with retries.
- **Outbound channel** - a REST endpoint that accepts raw HL7 or JSON, builds the HL7 message, sends it over MLLP in strict per-channel order, waits for the ACK and records the result with retries.
- **Dashboard** - channels, start/stop, message log with search and paging, HL7 beside JSON, test-send, resend, API keys and webhook secrets.
- **Housekeeping** - per-channel IP allowlist, per-channel retention (default 7 days) with an hourly cleanup job, health endpoint, Swagger docs.

## Stack

| Layer | Choice |
|---|---|
| API | NestJS 12 (ESM), Drizzle ORM, PostgreSQL 16, pg-boss queues, nestjs-pino, Zod-validated env |
| HL7 | `node-hl7-server` for listeners, raw `net`/`tls` MLLP sender, own lossless HL7 <-> JSON codec in `packages/schemas` |
| Auth | Better Auth (email + password, sign-up disabled, seeded admin), hashed per-channel API keys for the send endpoint |
| Web | React + Vite, Tailwind 4, shadcn/ui, TanStack Query, React Router, react-hook-form with the shared Zod schemas |
| Repo | npm workspaces + Turborepo, Node 22, TypeScript 5.9 |

```
apps/api            NestJS API, channel manager, MLLP listeners/sender, delivery workers, retention job
apps/web            React dashboard (Vite)
packages/schemas    Shared Zod schemas, HL7 <-> JSON codec, port-range helper
docs/               PLAN.md (design), HANDOVER.md (current state), NEXT.md (tracker), reports/
docker-compose.yml  Dev hot-reload service used by Coolify (see Deployment)
.env.example        Every supported environment variable
```

## Development

### Prerequisites

- Node 22 and npm 10 (or run everything inside `node:22-alpine`, see below)
- Docker, for the local Postgres and for the API tests (Testcontainers)

### 1. Database

```bash
docker run -d --name ackwell-db \
  -e POSTGRES_USER=ackwell -e POSTGRES_PASSWORD=ackwell -e POSTGRES_DB=ackwell \
  -p 5432:5432 postgres:16
```

### 2. Environment

The API reads plain process environment variables (no dotenv). Copy the example and export it:

```bash
cp .env.example .env
# edit DATABASE_URL, BETTER_AUTH_SECRET (32+ chars), SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (12+ chars)
set -a && . ./.env && set +a
```

For a laptop set `DATABASE_URL=postgres://ackwell:ackwell@localhost:5432/ackwell`, `APP_URL=http://localhost:5173` and `MLLP_ADVERTISED_HOST=localhost`.

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres for app data and pg-boss | required |
| `PORT` | API HTTP port | `3000` |
| `APP_URL` | Public base URL (auth trusted origin, links) | `http://localhost:3000` |
| `BETTER_AUTH_SECRET` | Session signing secret, 32+ chars | required |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Optional unattended first admin; unset = setup wizard with a token from the log | unset |
| `MLLP_PORT_RANGE` | Ports inbound channels may listen on | `6100-6150` |
| `MLLP_ADVERTISED_HOST` | Host shown to senders in the UI | `localhost` |
| `MLLP_BIND_ADDRESS` | Address listeners bind to | `0.0.0.0` |
| `RETENTION_DEFAULT_DAYS` | Default message retention | `7` |
| `DELIVERY_RETRY_DELAY_SECONDS` | Webhook retry base delay (exponential, max 10 min) | `10` |
| `QUEUE_POLL_SECONDS` | pg-boss poll interval | `2` |
| `LOG_LEVEL` | Pino level | `info` |

### 3. Run

```bash
npm install
npm run dev
```

Turborepo builds `packages/schemas` first, then runs the API in watch mode on `:3000` and Vite on `:5173`. Vite proxies `/api` and `/health` to the API, so open **http://localhost:5173**. Migrations run automatically on API start.

**First admin.** With no users in the database the app shows a setup wizard instead of the login page. The API log prints a one-time token in a box headed `Ackwell first-run setup`; enter it in the wizard, choose the admin email and password, and you are signed in. The token changes on every restart and after five wrong attempts. To skip the wizard (unattended installs), set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before the first start.

Useful URLs: `/api/docs` (Swagger), `/health`.

### Tests, typecheck, migrations

```bash
npm test            # schemas unit tests, API e2e (starts Postgres via Testcontainers), web component tests
npm run typecheck
npm run db:generate -w @ackwell/api -- --name <change>   # after editing apps/api/src/db/schema.ts
```

The API e2e tests bind MLLP listeners on ports 6040-6050, so keep those free.

### Without Node on the host

Everything also runs inside a container. From the repo root:

```bash
docker run --rm -it --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD":/app -w /app node:22-alpine \
  sh -c "npm install && npm run build -w @ackwell/schemas && npx turbo run test typecheck"
```

### Try it with HL7

**Inbound:** create an inbound channel in the dashboard, pick a port in the range, add the sender's IP (or CIDR) to the allowlist, start it, then send to `<MLLP_ADVERTISED_HOST>:<port>` with HL7 Soup, `mllp_send`, or this snippet:

```python
import socket
msg = "MSH|^~\\&|SENDER|LAB|ACKWELL|LAB|20260101120000||ORU^R01|MSG0001|P|2.5\rPID|1||12345||DOE^JOHN\r"
s = socket.create_connection(("172.16.10.30", 6100))
s.sendall(b"\x0b" + msg.encode() + b"\x1c\x0d")
print(s.recv(4096))   # MSH...|ACK^R01|...\rMSA|AA|MSG0001
```

A sender outside the allowlist is closed on connect, so the client reports "no response". The API log shows `Rejected connection from <ip> ... (not in allowlist)`.

**Outbound:** create an outbound channel with the target host/port, create an API key on its page, then:

```bash
curl -X POST https://<host>/api/channels/<id>/send \
  -H "Authorization: Bearer ak_..." -H "Content-Type: text/plain" \
  --data-binary $'MSH|^~\\&|ACKWELL|LAB|LIS|LAB|||ORM^O01|ORD0001|P|2.5\rPID|1||12345||DOE^JOHN'
```

**Webhook verification:** deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/). Headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`); signed content is `${id}.${timestamp}.${body}` with HMAC-SHA256 over the bytes of the secret after the `whsec_` prefix (base64). Two signatures are sent during a secret rotation; reject timestamps older than 5 minutes.

## Deployment

The app follows the server rules in `/root/project/CLAUDE.md`: everything deploys through Coolify, one resource per project, public URL `https://<project>.joemarkgimeno.com` behind Coolify's Traefik proxy, secrets only in Coolify env vars.

### Current: dev hot-reload service (what is live)

`docker-compose.yml` runs one `node:22-alpine` container with `npm install && npm run dev`, the repo bind-mounted at `/app` and `node_modules` in a named volume. Saving a file on the server updates the live site. The Coolify pieces:

1. **Database** - a Coolify-managed PostgreSQL 16 resource (`ackwell-db`) in project `dev-projects` / environment `development`, internal only, daily backups.
2. **Service** - a Coolify *custom service* created from `docker-compose.yml` (`POST /api/v1/services` with the file base64 in `docker_compose_raw`), "Connect to Predefined Network" enabled so it can reach `ackwell-db` by name.
3. **Env vars** on the service: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, optionally `MLLP_BIND_IP`. Everything else is set in the compose file.
4. **Domain** - `https://ackwell.joemarkgimeno.com:5173`, so the proxy targets the Vite dev server, which proxies the API. Coolify issues the certificate.
5. **MLLP ports** - raw TCP cannot go through Traefik or Cloudflare, so the compose file publishes `6100-6150` on the machine's LAN IP only (`172.16.10.30`). HL7 senders on the LAN connect to that IP, not the domain. This host-port mapping is an approved exception to the server rules.

After a change to `turbo.json`, dependencies or env vars, restart the service (`POST /api/v1/services/<uuid>/restart`); source edits hot-reload. Logs: `docker logs app-<service-uuid>`.

Verify: `curl -I https://ackwell.joemarkgimeno.com` returns the app, `/health` is `ok`, and a test message to a running listener gets an `AA` ACK.

**First run on a fresh deployment.** Open the site: with an empty database it shows the setup wizard. Get the token from the service's logs in Coolify (or `docker logs app-<service-uuid>`), look for the `Ackwell first-run setup` box, paste the token, create the admin. Only someone who can read the server log can do this, which is the whole point. `GET /api/setup/status` tells whether the wizard is still open.

### Production image (planned, Phase 9)

Not in the repo yet. The design in `docs/PLAN.md`: a multi-stage `Dockerfile` that builds `apps/web` and `apps/api` into one image where NestJS serves the built SPA, migrations on start, graceful shutdown on SIGTERM, a single replica because listeners own ports, deployed from this Git repository with Coolify's Docker Compose build pack and auto-deploy on push to `main`.

## Brand assets

`apps/web/public/brand/` holds the mark (`ackwell-mark.svg`, `ackwell-mark-512.png`), horizontal lockups for light and dark backgrounds (`ackwell-logo*.svg` with the Geist wordmark embedded, plus PNG exports) and a social card. Brand teal is `#00978a` (dark theme `#26bdae`). Favicons, touch icon and web manifest live in `apps/web/public/`.

## More

- `docs/HANDOVER.md` - current state, decisions, live URLs and credentials locations. Read this first.
- `docs/NEXT.md` - progress tracker and what comes next.
- `docs/PLAN.md` - the approved design.
- `docs/reports/` - per-phase implementation reports.
