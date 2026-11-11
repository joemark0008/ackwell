# Phase 5 — Delivery (pg-boss queue, DeliveryAdapter, signed webhooks)

**Date:** 2026-11-11 · **By:** main session (acting as backend-dev + frontend-dev) · **Status:** done, live on dev

## Task
Deliver every parsed inbound message to the channel's target through a pluggable adapter. v1 ships the
webhook adapter: JSON body, Standard Webhooks HMAC-SHA256 signing, two-secret rotation, retries with
backoff, every attempt recorded, resend from the UI.

## What changed (files)
### `packages/schemas`
- `src/webhook.ts` — **new** `webhookSecretSchema` (public view: id, hint = last 4 chars, createdAt, revokedAt),
  `newWebhookSecretSchema` (+ `secret`, returned once), `createChannelResponseSchema` (channel + optional
  `webhookSecret`), `webhookPayloadSchema`, `WEBHOOK_HEADERS`.

### `apps/api`
- `src/queue/queue.module.ts` — **new** `QueueService` wrapping **pg-boss 12** (schema `pgboss` on the app DB, started
  in `onModuleInit`, graceful stop on shutdown, `ensureQueue`). Global module.
- `src/common/events.ts` — **new** global `AppEvents` emitter (`message`, `channel.status`) shared by the channel
  manager and the delivery worker (SSE source later). `ChannelManager` now uses it instead of its own emitter.
- `src/delivery/delivery-adapter.ts` — **new** `DeliveryAdapter` interface (`type`, `deliver(ctx) → DeliveryResult`)
  + `DeliveryRegistry`.
- `src/delivery/standard-webhooks.ts` — **new** `generateSecret` (`whsec_` + base64 of 32 bytes), `sign`,
  `signedHeaders` (one `v1,…` per active secret), `verify` (constant-time, 5-minute replay window; the receiver-side
  reference). `standard-webhooks.test.ts` — 6 unit tests.
- `src/delivery/webhook-secrets.service.ts` / `.controller.ts` — **new** secrets per channel: `createInitial` (in the
  channel insert transaction), `rotate` (keeps the previous newest active, revokes older), `revoke`, `list`.
- `src/delivery/webhook.adapter.ts` — **new** webhook adapter: `fetch` POST with `AbortSignal.timeout(timeoutMs)`,
  JSON payload (`id, channelId, channelName, direction, receivedAt, messageType, controlId, remoteAddress, raw, json`),
  signed with every active secret. Retryable = network error / timeout / 5xx / 408 / 429; other 4xx fail permanently;
  no active secret → permanent failure with a clear message.
- `src/delivery/delivery.service.ts` — **new** queue `delivery`: `enqueue(messageId, delivery, tx?)` (pg-boss
  `fromDrizzle(tx, sql)` so the job commits with the message row), worker (`batchSize 1`, `localConcurrency 4`),
  attempt recording in `delivery_attempts`, status transitions, `resend`.
- `src/messages/messages.service.ts` — `recordInbound` now inserts + enqueues in one transaction; `resend`.
  `messages.controller.ts` — `POST /api/messages/:id/resend`.
- `src/channels/channels.service.ts` — inbound create returns `webhookSecret` (once), created in the same transaction.
- `src/health/health.controller.ts` — `queue: ok|stopped`; 503 when pg-boss is not running.
- `src/config/env.ts` — `DELIVERY_RETRY_DELAY_SECONDS` (default 10), `QUEUE_POLL_SECONDS` (default 2); added to
  `turbo.json` passthrough and `.env.example`.
- `src/db/schema.ts` — `webhook_secrets` table. `test/delivery.e2e.test.ts` — **new** (8 tests, local HTTP receiver).

### `apps/web`
- `lib/api.ts`, `lib/queries.ts` — webhook secrets (list / rotate / revoke), resend, typed create response.
- `components/webhook-secret-dialog.tsx` — **new** one-time secret reveal (copy, header explanation, Node verify
  snippet). Opened after creating an inbound channel (`pages/channel-form.tsx`) and after a rotation.
- `components/webhook-card.tsx` — **new** on inbound channel pages: URL + retries, active secrets with hints,
  Generate / Rotate (confirm) / Revoke (confirm), warning when no active secret. `webhook-card.test.tsx` — 2 tests.
- `components/message-dialog.tsx` — Resend button for inbound messages. `test/setup.ts` — `ResizeObserver` stub.

## Endpoints / schemas added or changed
| Method | Path | Notes |
|---|---|---|
| POST | `/api/channels` | inbound: response now includes `webhookSecret { id, hint, secret, … }` **once** |
| GET | `/api/channels/:id/webhook-secrets` | hints only, never the value |
| POST | `/api/channels/:id/webhook-secrets/rotate` | 201 new secret (shown once); previous newest stays active; older revoked |
| DELETE | `/api/channels/:id/webhook-secrets/:secretId` | revoke (404 `SECRET_NOT_FOUND` if not active) |
| POST | `/api/messages/:id/resend` | re-queue delivery; 400 `NOT_DELIVERABLE` for channels without delivery |
| GET | `/health` | `{ status, db, queue }` |

Webhook request: `POST <delivery.url>` · `content-type: application/json` · `user-agent: Ackwell-Webhook/0.1` ·
`webhook-id` (= message id) · `webhook-timestamp` (unix s) · `webhook-signature: v1,<b64> [v1,<b64>]`, HMAC-SHA256 over
`${id}.${timestamp}.${body}` with the decoded `whsec_` secret.

Message status (inbound): `received` (queued) → `processing` (tried, waiting for retry) → `delivered` | `failed`.

## Migrations
- `0003_webhook_secrets` — table `webhook_secrets` (channel_id FK cascade, secret, created_at, revoked_at). Applied on dev.
- pg-boss creates/migrates its own `pgboss` schema on start (not a Drizzle migration).

## Tests (command + result)
Same command as Phase 2 (`npm run build -w @ackwell/schemas && npx turbo run test typecheck` in `node:22-alpine`
with `--network host` + docker socket).
- schemas 21/21 · API 41/41 (new: standard-webhooks 6, delivery e2e 8: create → one-time secret, signed delivery +
  payload, 503/500→200 backoff with 3 recorded attempts, maxAttempts 2 → `failed` then resend → `delivered`, 404 not
  retried, rotation (two signatures) + auto-revoke of the oldest + explicit revoke, no-secret failure, resend 404) ·
  web 12/12 · typecheck clean · `vite build` OK.
- Live (dev): receiver on `127.0.0.1:9999` inside the dev container, temporary channel `Webhook smoke` on 6101,
  MLLP `HOOK0001` → `delivered`, attempt `1 success 200 OK`, signature verified in Python with the one-time secret,
  payload complete. Channel deleted afterwards. `/health` → `queue: ok`.

## Decisions
- **Secrets are stored in clear** (the app must sign with them). They are returned once, listed as hints only,
  never logged. The DB is LAN-only (PLAN: no encryption at rest). API keys (Phase 7) will be hashed as planned.
- **Retries are pg-boss's**: per-job `retryLimit = maxAttempts − 1`, exponential backoff from
  `DELIVERY_RETRY_DELAY_SECONDS` (10 s → 20 → 40 …, capped at 10 min). The worker throws to hand a retryable failure
  back; permanent failures (4xx, no secret, unparseable) are settled by the worker.
- **Resend** starts a new job for the same message; attempt numbers continue (1, 2, 3 …) across resends.
- Existing inbound channels (created before Phase 5) have **no secret**: the channel page shows a warning and a
  *Generate secret* button; deliveries fail with "No active webhook secret" until then.

## Open issues / questions for the lead
- The live sample channel `Lab results in` points at `https://ehr.local/hl7/inbound` (unreachable): new messages
  there will show `processing` → `failed` with `Request failed: ENOTFOUND` after 10 retries. Expected.
- SSE is still not built (polling). `AppEvents` is ready for it.
- Retention (Phase 6) must skip `received`/`processing` messages (pending delivery/retry).
