Ackwell

A full-stack app for creating HL7 v2 channels:

Inbound channel — an MLLP server anyone can send HL7 to; messages are parsed to JSON.
Outbound channel — accepts JSON over REST, converts it to HL7, and sends it to another HL7 server.

Status: planning. Nothing is built yet.

How it works
Inbound channel (HL7 → JSON)
Channel config holds the port, HL7 version, TLS, allowed source IPs, and delivery target.
The backend starts an MLLP listener for the channel at runtime (start/stop from the UI).
For each message: save raw HL7 → send ACK → parse to JSON → deliver through the channel's delivery adapter (webhook in v1).
Outbound channel (JSON → HL7)
Channel config holds the target host/port, TLS, HL7 version, and retry policy.
POST /channels/:id/send accepts JSON and queues it.
A worker builds the HL7, sends it over MLLP, waits for the ACK, and records the result (AA/AE/AR, retries).
Shared
Message log — raw HL7, JSON, status, ACK, timestamps, errors; resend from the UI.
UI — channel CRUD, start/stop, live message viewer, test-send box.
Stack
Backend
Layer	Tool	Used for
Runtime	Node.js 22+, TypeScript	Required by the HL7 libraries
Framework	NestJS	API, channel manager, workers
HL7 inbound	node-hl7-server	MLLP listeners, one per channel, with ACKs
HL7 outbound	node-hl7-client	Build HL7 from JSON, send, await ACK
Database	PostgreSQL	Channels, messages (raw + jsonb), delivery attempts, job queue
ORM	Drizzle	Schema and migrations; jsonb columns
Queue	pg-boss (Postgres-backed, no Redis)	Outbound sends and webhook deliveries with retry/backoff; scheduled retention cleanup
Validation	Zod	Channel configs and incoming JSON payloads
API	REST + OpenAPI (@nestjs/swagger)	External JSON senders and the UI
Live updates	Server-Sent Events	Live message feed and channel status
Auth	Better Auth (UI), hashed API keys per channel (machines)	Separate auth for people and systems
Logging	nestjs-pino	Structured logs with channel and message IDs
Metrics	prom-client, Prometheus, Grafana	Messages per minute, ACK failures, queue depth
Frontend
Layer	Tool	Used for
App	React + Vite	Dashboard SPA
Data	TanStack Query	API calls and caching
Tables	TanStack Table	Message log with filters and paging
UI	shadcn/ui + Tailwind	Forms, dialogs, layout
Forms	React Hook Form + Zod	Channel create/edit, schemas shared with the backend
Editor	Monaco	Raw HL7 and JSON side by side; test-send box
Dev and ops
Layer	Tool	Used for
Monorepo	npm workspaces + Turborepo	api, web, shared schemas
Tests	Vitest, Testcontainers	Parser round-trips on real HL7 samples; Postgres in tests
HL7 test tool	HAPI TestPanel	Send and receive test messages
Packaging	Docker (multi-stage build)	One image: the API also serves the built web app
Deploy targets	Docker Compose, Coolify, Kubernetes (Helm + ArgoCD on MicroK8s)	See Deployment
CI	GitHub Actions	Lint, test, build and push the image
Networking	Published host ports (Docker/Coolify) or MetalLB (Kubernetes) for the MLLP range; reverse proxy for UI/API	HL7 is raw TCP and cannot go through an HTTP proxy
Repository layout
apps/
  api/        NestJS backend (API, channel manager, workers)
  web/        React + Vite dashboard
packages/
  schemas/    Shared Zod schemas and types
deploy/
  helm/       Helm chart
Dockerfile            Multi-stage build for the single app image
docker-compose.yml    App + Postgres (used by plain Docker and by Coolify)
.env.example          All supported environment variables
docs/
  PLAN.md     This file
Data model (first pass)
channels — id, name, direction (inbound | outbound), status, HL7 version, retention days (default 7), config (jsonb: port or target host/port, TLS, allowlist, retry policy), delivery (jsonb: { type: "webhook", ...settings }), timestamps.
messages — id, channel id, direction, raw HL7, JSON (jsonb), message type (e.g. ORU^R01), control id (MSH-10), status, ACK code, error, timestamps. Index on (channel id, created at) for the log view and retention deletes.
delivery_attempts — id, message id, attempt number, result, response/ACK, error, timestamp.
api_keys — id, channel id, key hash, label, last used, revoked at.
Design decisions
JSON format — generic and lossless first (segments → fields → components) so any message type round-trips. Per-channel mapping templates for friendly JSON come later.
Persist before ACK — never acknowledge a message that is not yet written to Postgres.
MLLP port range — preallocate a range (default 6000–6050) that channels pick from. Docker and Coolify publish it as host ports; Kubernetes exposes it on one MetalLB LoadBalancer service.
Queue — pg-boss on the same Postgres, so there is no Redis to run. Enqueue the job in the same transaction that saves the message where possible.
Outbound ordering — one pg-boss queue per channel, processed one job at a time, since many HL7 receivers expect messages in order. Confirm the right queue policy for strict ordering when implementing.
Inbound delivery (pluggable) — v1 ships webhook only, behind a DeliveryAdapter interface (type, config schema, deliver(message)). The channel stores delivery.type plus adapter settings, and a registry resolves the adapter at runtime. Adding NATS or another target later means one new adapter and its Zod config schema, with no change to the channel pipeline, queue, or DB schema.
Webhook signing — every webhook is signed with HMAC-SHA256, following the Standard Webhooks convention:
Headers: webhook-id (message id, also the receiver's idempotency key), webhook-timestamp (Unix seconds), webhook-signature (v1,<base64 HMAC>).
Signed content: {id}.{timestamp}.{raw body}, using a per-channel secret generated by the app (32 random bytes) and shown once in the UI.
Receivers verify with a constant-time compare and reject timestamps older than 5 minutes (replay protection).
Secret rotation: a channel can hold two active secrets during a rotation, sending both signatures so receivers can switch without downtime.
Encryption at rest — not used. The app runs on the local network only, so raw HL7 is stored as plain text in Postgres. Revisit if it is ever exposed beyond the LAN.
Message retention — configurable per channel in days (default 7), with a global default from env. A scheduled pg-boss job runs hourly and deletes expired messages and their delivery attempts in batches. Messages still pending delivery or retry are skipped.
Security — MLLP has no auth: IP allowlist per channel plus optional TLS. API keys for the send endpoint.
Run mode — single replica for v1, because listeners hold ports. Multiple replicas would need leader election per channel.
Deployment

All targets run the same image and the same rules:

One image — a multi-stage Dockerfile builds web and api; the NestJS app serves the built SPA, so there is one app container plus Postgres.
Single replica — listeners hold ports, so run exactly one app instance.
Migrations — Drizzle migrations run on container start, before the app accepts traffic.
Health — GET /health (DB reachable, queue running) for container healthchecks.
Graceful shutdown — on SIGTERM, stop accepting new MLLP connections, finish in-flight messages, stop pg-boss, then exit.
MLLP ports — a fixed range (default 6000-6050) set by MLLP_PORT_RANGE; channels can only use ports inside it, and the same range is published by the host or cluster.
Environment variables
Variable	Purpose
DATABASE_URL	Postgres connection (app data and pg-boss)
PORT	HTTP port for the API and UI (default 3000)
APP_URL	Public base URL, used by auth and links
BETTER_AUTH_SECRET	Session signing secret
MLLP_PORT_RANGE	Ports channels may listen on (default 6000-6050)
RETENTION_DEFAULT_DAYS	Default message retention (default 7)
LOG_LEVEL	Pino log level
Docker (Compose)
docker-compose.yml defines two services: app and postgres.
app publishes the HTTP port and the MLLP range, e.g. 3000:3000 and 6000-6050:6000-6050.
postgres uses a named volume for data and a healthcheck; app waits for it with depends_on: condition: service_healthy.
Configuration comes from a .env file copied from .env.example.
restart: unless-stopped on both services.
Run: docker compose up -d; upgrade: docker compose pull && docker compose up -d.
Backups: scheduled pg_dump of the Postgres volume (cron on the host or a small sidecar).
Coolify
Deploy from the Git repository using the Docker Compose build pack, reusing the same docker-compose.yml.
Assign the domain to the app service's HTTP port; Coolify's proxy handles routing and TLS for the UI/API.
The MLLP range bypasses the proxy: keep it as published host ports in the compose file, and open those ports on the server firewall for the LAN only.
Set environment variables and secrets in the Coolify UI rather than committing a .env file.
Database: either the postgres service in the compose file, or a Coolify-managed PostgreSQL resource with DATABASE_URL pointing at it. The managed option is preferred because it gives scheduled backups from the Coolify UI.
Enable auto-deploy on push to the main branch; the container healthcheck gates a deploy as healthy.
Keep it to one instance (no scaling), for the same port-ownership reason.
Verify the exact compose and port-mapping behaviour against the Coolify docs for the installed version during setup.
Kubernetes (optional)
Helm chart with a single-replica Deployment using the Recreate strategy, so two pods never compete for the ports.
A MetalLB LoadBalancer service exposes the MLLP range; ingress + cert-manager expose the UI/API.
ArgoCD syncs the chart; GitHub Actions builds and pushes the image.
Build order
Core — monorepo, DB schema, channel CRUD API.
Inbound — channel manager that starts/stops listeners; persist → ACK → parse to JSON.
Outbound — send endpoint, queue worker, ACK tracking, retries.
UI — channels page, message log, HL7/JSON viewer, test-send, resend.
Delivery — DeliveryAdapter interface and signed webhook adapter for inbound JSON, with retries.
Retention — per-channel retention setting and the scheduled cleanup job.
Hardening — API keys, IP allowlist, TLS, metrics.
Deployment — Dockerfile, docker-compose.yml, .env.example, health endpoint, graceful shutdown; then the Coolify setup. Helm chart only if Kubernetes is needed.
File transport (planned, see docs/PLAN-FILE-TRANSPORT.md) — a second connection type next to MLLP: outbound channels write .hl7 order files into a shared folder (atomic temp + rename); inbound channels watch a shared folder with chokidar (polling for network shares, awaitWriteFinish), import result files (one message per file), deliver them like MLLP messages and move them to PROCESSED or ERROR. Folders: ORDER, RESULT, PROCESSED, ERROR. Existing MLLP channels are unchanged (new channels.transport column, default 'mllp').
Later — NATS and other delivery adapters; per-channel mapping templates for friendly JSON.
HL7 libraries

Use the latest releases of both packages, which are published from the node-hl7 monorepo (the older standalone repos are superseded). Requires Node.js 22+.

bash
npm install node-hl7-client@latest node-hl7-server@latest
Source (monorepo): https://github.com/Bugs5382/node-hl7
npm: https://www.npmjs.com/package/node-hl7-client , https://www.npmjs.com/package/node-hl7-server
API docs: https://bugs5382.github.io/node-hl7-client/ , https://bugs5382.github.io/node-hl7-server/
