# Phase 2 — Inbound listeners (backend + UI wiring)

**Date:** 2026-11-11 · **By:** main session (acting as backend-dev + frontend-dev) · **Status:** done, live on dev

## Task
Start/stop MLLP listeners per inbound channel at runtime, persist every message before ACKing it, parse HL7 to
lossless JSON, expose the message log over the API, and wire Start/Stop + the message log into the dashboard.

## What changed (files)
### `packages/schemas`
- `src/hl7.ts` — **new** lossless HL7 ↔ JSON codec (`parseHl7`, `buildHl7`, `hl7JsonSchema`, header helpers
  `messageTypeOf` / `controlIdOf` / `versionOf`, `unescapeHl7` for display). Browser-safe (no Node APIs), so the
  web app can use it for the test-send box later.
- `src/message.ts` — **new** `messageSummarySchema`, `messageDetailSchema` (raw + json + attempts),
  `messageListQuerySchema` (limit / cursor / status / q), `messageListSchema` (items, nextCursor, total).
- `src/hl7.test.ts` — 14 round-trip and shape tests (ORU, ADT, subcomponents, repeats, escapes kept verbatim,
  trailing empty fields, custom delimiters, LF/CRLF input, malformed input).

### `apps/api`
- `src/channels/inbound-listener.ts` — **new** wrapper around `node-hl7-server`: `start()` resolves on `listen`
  and rejects with the socket error (EADDRINUSE…); IP allowlist enforced on `client.connect` (socket destroyed
  before any data); raw frame captured from `data.raw`; handler returns the ACK code, sent only after it resolves.
- `src/channels/allowlist.ts` — **new** `net.BlockList`-based allowlist (IPv4/IPv6 + CIDR; `::ffff:` mapped IPv4
  normalised).
- `src/channels/channel-manager.service.ts` — **new** `ChannelManager`: `start(id)` / `stop(id)` (idempotent, per-
  channel lock → 409 `CHANNEL_BUSY`), status mirrored to `channels.status`, restore of `running` channels on boot
  (failures → `error`), listeners closed on shutdown (statuses untouched so the next boot restores them), an
  `EventEmitter` (`message`, `status`) ready for SSE.
- `src/messages/messages.service.ts` — **new** inbound pipeline step (`recordInbound`: parse → insert → ACK
  decided by the caller), keyset-paged `list`, `get` with delivery attempts.
- `src/messages/messages.controller.ts`, `messages.module.ts` — **new**.
- `src/channels/channels.controller.ts` — routes added (below); `channels.module.ts`, `app.module.ts` wired.
- `src/config/env.ts` — `MLLP_BIND_ADDRESS` (default `0.0.0.0`); added to `turbo.json` passthrough and
  `.env.example`.
- `src/db/schema.ts` — `messages.remote_address` + `MessageRow` / `DeliveryAttemptRow` types.
- `test/mllp-client.ts` — **new** raw MLLP client + samples; `test/helpers.ts` can now reuse a Postgres container
  across app restarts; `test/listeners.e2e.test.ts` — **new** (8 tests).

### `apps/web`
- `lib/api.ts`, `lib/queries.ts` — start/stop mutations, `useMessages` (infinite query, cursor paging, 4 s polling
  while the channel runs), `useMessage`.
- `components/start-stop-button.tsx` — **new** button (detail page) + menu item (list row) with toasts and error
  mapping (`PORT_UNAVAILABLE`, `CHANNEL_BUSY`).
- `components/messages-card.tsx` — **new** message log: search (type / control id), status filter, table, "Load
  older messages", live indicator; `components/message-dialog.tsx` — **new** raw HL7 beside JSON (tabs on phones),
  ACK / from / time, error, delivery attempts.
- `components/badges.tsx` — `MessageStatusBadge`, `AckBadge`; `lib/format.ts` — `formatLogTime`.
- `pages/channel-detail.tsx`, `pages/channels-list.tsx` — wired. `components/messages-card.test.tsx` — 2 tests.

## Endpoints / schemas added or changed
| Method | Path | Notes |
|---|---|---|
| POST | `/api/channels/:id/start` | 200 channel; 409 `PORT_UNAVAILABLE` (EADDRINUSE/EACCES → status `error`), 409 `CHANNEL_BUSY`, 500 `LISTENER_ERROR`. Outbound: status only until Phase 3. |
| POST | `/api/channels/:id/stop` | 200 channel, idempotent |
| GET | `/api/channels/:id/messages?limit&cursor&status&q` | newest first, keyset cursor, `total` |
| GET | `/api/messages/:id` | raw, json, attempts; 404 `MESSAGE_NOT_FOUND` |

JSON format: see the header comment of `packages/schemas/src/hl7.ts` (segments → fields → repeats → components →
subcomponents, escapes kept, MSH-1/2 raw).

## Migrations
- `0002_message_remote_address` — `ALTER TABLE messages ADD COLUMN remote_address text`. Applied on dev.

## Tests (command + result)
```
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD":/app -w /app node:22-alpine \
  sh -c "npm run build -w @ackwell/schemas && npx turbo run test typecheck"
```
- schemas 21/21 · API e2e 27/27 (listeners 8: start/bind, AA + JSON, paging + filters, running lock + stop,
  PORT_UNAVAILABLE, allowlist reject/allow, outbound status, boot restore + shutdown) · web 10/10 · typecheck clean ·
  `vite build` OK.
- Live: `Lab results in` started on 6100; `python mllp_send.py 192.0.2.30 6100 LIVE0001` →
  `MSA|AA|LIVE0001`; message listed (`ORU^R01`, from `192.0.2.30`) with JSON; dialog shows raw + JSON.

## Decisions
- **Any HL7 version is accepted** (`acceptAnyVersion`), so a sender with a different MSH-12 than the channel's
  `hl7Version` is still logged rather than silently AR'd. `hl7Version` is used for ACK/outbound building.
- Unparseable HL7 (never seen in tests; `node-hl7-server` parses first) is still stored (`status failed`, error
  text) and answered `AE`; a failed insert answers `AR` and stores nothing.
- Batch/file (BHS/FHS) frames: the library unpacks them; each message is stored from `Message.toString()`.
- No pg-boss yet: inbound messages stay `received` until the Phase 5 delivery adapter picks them up.

## Open issues / questions for the lead
- SSE for the live feed is not built; the UI polls every 4 s while a channel runs (`LIVE_POLL_MS`).
- Monaco is not used yet; the dialog uses `<pre>` panes (swap in Phase 4).
- Dev container gotcha (fixed today): `node_modules` lives in a named volume, so `npm install` must run **inside**
  the container (or restart it) after adding dependencies; a `tsup --clean` of `packages/schemas` from an outside
  container confuses the in-container `nest --watch` until the container restarts.
