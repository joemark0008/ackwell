# Phase 3 — Outbound (send endpoint, API keys, ordered MLLP sending, ACK tracking)

**Date:** 2026-11-11 · **By:** main session (acting as backend-dev + frontend-dev) · **Status:** done, live on dev

## Task
Accept JSON/HL7 over REST on an outbound channel, queue it, send it over MLLP to the channel's target one message
at a time in order, wait for the ACK and record AA/AE/AR with retries; machine auth with per-channel API keys;
test-send box and keys in the dashboard.

## What changed (files)
### `packages/schemas`
- `src/outbound.ts` — **new** `sendRequestSchema` (`{ hl7 }` raw text **or** the generic `{ segments }` JSON),
  `sendResponseSchema`, `apiKeySchema` / `newApiKeySchema` / `createApiKeySchema`.

### `apps/api`
- `src/outbound/mllp-sender.ts` — **new** raw TCP/TLS MLLP sender: connect → frame → ACK → destroy, hard
  `ackTimeoutMs`, ACK parsed with our codec (MSA-1 / MSA-2). `MllpSendError` with a code
  (ECONNREFUSED / ETIMEDOUT / ACK_TIMEOUT / CLOSED / BAD_ACK).
- `src/outbound/outbound.service.ts` — **new** queue `outbound` (**pg-boss policy `key_strict_fifo`**, `singletonKey`
  = channel id → strict per-channel order, channels in parallel), `send()` (validates, completes MSH-7/10/12, inserts
  the message `queued` + job in one transaction), worker (attempts in `delivery_attempts`, status transitions),
  `resend()`.
- `src/outbound/api-keys.service.ts` — **new** keys `ak_` + 32 random bytes (base64url), stored as SHA-256 + an
  11-char prefix for display; `authenticate()` updates `lastUsedAt`.
- `src/outbound/send-auth.guard.ts` — **new** `Authorization: Bearer ak_…` (must belong to the channel) **or** a
  dashboard session; the route is `@Public()` so the global guard defers.
- `src/outbound/outbound.controller.ts`, `outbound.module.ts` — routes below.
- `src/messages/messages.service.ts` — `resend` branches by direction (outbound → re-queue the send).
- `src/queue/queue.module.ts` — `ensureQueue` no longer tries to change the policy of an existing queue (pg-boss
  rejects that).
- `src/channels/channel-manager.service.ts` — boot log counts inbound listeners only.
- `src/db/schema.ts` — `api_keys.key_prefix`. `test/outbound.e2e.test.ts` — **new** (9 tests, raw MLLP receiver).

### `apps/web`
- `lib/api.ts`, `lib/queries.ts` — send, API keys (list / create / revoke).
- `components/test-send-card.tsx` — **new** textarea prefilled with a sample ADT, sends as the signed-in user;
  the ACK shows up in the message log (polling while running).
- `components/api-keys-card.tsx` — **new** list (label, prefix, last used), create (label → key shown once),
  revoke (confirm). `api-keys-card.test.tsx` — 2 tests.
- `components/message-dialog.tsx` — Resend now for outbound messages too. `pages/channel-detail.tsx` — outbound
  page: corrected curl example (`{ "hl7": "…" }`), test-send + API keys cards.

## Endpoints / schemas added or changed
| Method | Path | Notes |
|---|---|---|
| POST | `/api/channels/:id/send` | Bearer API key or session. Body `{ "hl7": "MSH|…" }` or `{ "segments": [...] }`. 201 message (`queued`); 400 `VALIDATION_ERROR` / `INVALID_HL7` / `NOT_OUTBOUND`; 401 `INVALID_API_KEY` / `UNAUTHENTICATED`; 409 `CHANNEL_STOPPED` |
| GET | `/api/channels/:id/api-keys` | prefixes only |
| POST | `/api/channels/:id/api-keys` `{ label }` | 201, key shown once |
| DELETE | `/api/channels/:id/api-keys/:keyId` | revoke; 404 `API_KEY_NOT_FOUND` |
| POST | `/api/messages/:id/resend` | now also outbound |

Message status (outbound): `queued` → `processing` (sending / waiting for a retry) → `sent` (AA/CA, `ackCode`) |
`rejected` (AE/AR/CE/CR, not retried) | `failed` (transport errors after `retry.maxAttempts`, fixed
`retry.backoffSeconds` between tries). Each try is a `delivery_attempts` row with the raw ACK as `response`.

## Migrations
- `0004_api_key_prefix` — `api_keys.key_prefix text not null default ''`. Applied on dev. pg-boss queue `outbound`
  (`key_strict_fifo`) is created on start.

## Tests (command + result)
Same command as before (`node:22-alpine`, `--network host`, docker socket).
- schemas 21/21 · **API 50/50** (new outbound e2e 9: stopped/inbound refusal, validation, raw send → AA + attempt
  with ACK, JSON form + header completion, AE → rejected, ACK timeout retries → failed, receiver down → failed →
  resend → sent with attempts 1,2,3, strict order of 4 messages with a slow receiver, API keys create/list/auth/
  wrong/other-channel/revoke, log filter by `sent`) · web 14/14 · typecheck clean · `vite build` OK.
- Live (dev): loopback — temporary inbound listener on 6102 + temporary outbound channel to `127.0.0.1:6102`, three
  sends with a Bearer key → all `sent` / `AA`, received on the inbound side in order; MSH-7 filled; unauthenticated
  send → 401. Channels deleted afterwards. Screenshot of the outbound page: no console errors.

## Decisions
- **node-hl7-client is not used for sending.** Probed on 4.1.2: it needs `version` on both the client and the
  connection, opens two sockets per connection and `close()` leaves them open (verified: 2 server-side sockets
  stayed open after `close()`), so a worker would leak sockets. A 70-line raw `net`/`tls` sender replaced it; the
  library remains in use for inbound (`node-hl7-server` depends on it).
- **Ordering** comes from pg-boss `key_strict_fifo` with `singletonKey = channel id`: one in-flight send per channel;
  a retrying message holds the ones behind it. Note the policy also holds the key while a job is in pg-boss's
  `failed` state, so the worker always *completes* a job when it gives up (message `failed`), never leaves it failed.
- Stopping an outbound channel only refuses new sends (409); already-queued messages still go out.
- Keys are hashed (SHA-256; keys are 256-bit random so a fast hash is fine) and returned once.

## Open issues / questions for the lead
- A single persistent MLLP connection per channel would be faster for high volume; the sender is isolated so it can
  be swapped without touching the worker.
- TLS to the receiver uses `rejectUnauthorized: false` (self-signed LAN receivers); add CA / pinning in Hardening.
- Still no SSE (polling) and no Monaco.
