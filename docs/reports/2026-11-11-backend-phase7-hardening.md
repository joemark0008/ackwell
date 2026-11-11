## Task
Phase 7 backend: SSE `GET /api/events`, global log `GET /api/messages`, TLS (inbound listeners + outbound CA), Prometheus `GET /metrics`.

## What changed (files)
- `packages/schemas/src/channel.ts`, `message.ts`, `channel.test.ts`: TLS schemas, `globalMessageListQuerySchema`.
- `apps/api/src/events/events.controller.ts` (new): SSE endpoint. Wired in `app.module.ts`.
- `apps/api/src/metrics/` (new): `metrics.service.ts`, `metrics.controller.ts`, `metrics.module.ts` (global). `setup.ts` excludes `metrics` from the `/api` prefix. `env.ts`: `METRICS_TOKEN` only. `.env.example`: `METRICS_TOKEN`.
- `messages.service.ts`: `list(channelId, q)` now calls the shared `query(q)`; `messages.controller.ts`: `GET /messages`.
- `channels.service.ts`: key stripped from responses (`hasKey`), stored key kept on update. `inbound-listener.ts` + `channel-manager.service.ts`: TLS listener, metrics hooks. `mllp-sender.ts` + `outbound.service.ts`: `ca` / `rejectUnauthorized`.
- `outbound.service.ts` and `delivery.service.ts`: the `processing` transition now also emits a `message` event (it was silent before). All other transitions and both resend paths already emitted.
- Tests: `test/sse.e2e.test.ts`, `messages-global.e2e.test.ts`, `tls.e2e.test.ts`, `metrics.e2e.test.ts`, `sse-client.ts`, `test/fixtures/` (test-only CA/server/client certs and keys, README marks them test-only; the CA keys were discarded).
- No new npm dependency. Ran `npm install` once because `prom-client` was in package.json but not in node_modules.

## Endpoints / SSE events / schemas
- `GET /api/events[?channelId=uuid]` (session cookie; 401 JSON without one, 400 for a bad uuid). `event: message` / `data: MessageSummary`; `event: channel.status` / `data: {channelId,status,error?}` (always sent, even with the filter). Prelude `retry: 3000` + `: connected`, then `: ping` every 15 s. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; there is no compression middleware. Listeners are removed on disconnect (tested).
- `GET /api/messages?limit&cursor&status&q&channelId&direction` -> `MessageList` (same shape and ordering as `/channels/:id/messages`; tested equal).
- `GET /metrics` (public, no `/api` prefix, `Authorization: Bearer <METRICS_TOKEN>` when set, min 16 chars). Metrics:
  - `ackwell_messages_total{channel_id,channel_name,direction,status}`: `received` (inbound stored+ACKed, counted once, not on resend), `delivered`, `sent`, `rejected`, `failed`. `queued` and `processing` are not counted. A per-(id,status,updatedAt) dedupe guards double emits.
  - `ackwell_ack_failures_total{channel_id,direction}`: inbound AE/AR we sent, outbound rejected (AE/AR/CE/CR) received.
  - `ackwell_queue_depth{queue}` (pg-boss `queuedCount` for outbound, delivery, retention), `ackwell_channel_status{channel_id,channel_name,status}` (1/0 per status). Both are computed on scrape. Plus default Node metrics. A per-instance Registry is used, not the global one.
- Schema changes (frontend-dev must follow):
  - `inboundConfigSchema.tls` (write) is now `{enabled, cert?, key?, ca?, requestCert}`: `cert` and `key` are required when `enabled`, `ca` is required when `requestCert`, values must be PEM blocks (max 50k chars). `tlsConfigSchema` is kept as a deprecated alias of `inboundTlsSchema`.
  - `outboundConfigSchema.tls` is now `{enabled, ca?, rejectUnauthorized (default false)}` (`outboundTlsSchema`).
  - `channelSchema.config` (response) is now `inboundConfigResponseSchema | outboundConfigSchema`. Inbound `tls` is `{enabled:false}` when TLS is off and unused, otherwise `{enabled, cert?, ca?, requestCert, hasKey}`; the **private key is never returned**. New types: `InboundConfigResponse`, `InboundTls`, `OutboundTls`, `GlobalMessageListQuery`.
  - Update semantics: PATCH `config` still replaces the whole config. If `tls.enabled` and `key` is omitted, the stored key is kept; the response-only `hasKey` is accepted and ignored, so the UI may echo the response config back. `cert`/`ca` must be re-sent (the response includes them). The old web form sends `tls: {enabled: true}` only, which now fails validation (400, `config.tls.cert` / `config.tls.key`); it needs cert/key textareas (inbound) and ca + rejectUnauthorized (outbound). `config.tls.enabled=false` forms keep working unchanged.

## Migrations
None. TLS lives in the existing JSON `config` column.

## Tests (command + result)
`docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v /root/project/ackwell:/app -w /app node:22-alpine sh -c "npm run build -w @ackwell/schemas && npx turbo run test typecheck --filter=@ackwell/api --filter=@ackwell/schemas"`
- api: 13 files, **91/91** passed (new: SSE 5, global list 5, TLS 10, metrics 7). Typecheck clean. schemas: **25/25** passed (new TLS and global-query cases).
- SSE: 401 without session, 400 bad filter, headers, `channel.status` + `message` event from a real MLLP send, `channelId` filtering, listener cleanup.
- TLS: validation, no key leak in any response, key kept on update, MLLP over TLS persists then ACKs, wrong-CA client rejected, plain TCP not answered, allowlist enforced over TLS, mutual TLS (`requestCert` + `ca`). Outbound: `ca` + `rejectUnauthorized` succeeds, wrong CA + `rejectUnauthorized` fails (channel ends `failed`, receiver never got the message), default stays permissive.
- Metrics: token enforcement, open without token, all four series present, counts exact (not doubled).

## Open issues / questions for the lead
- The inbound TLS private key is stored in plaintext in `channels.config` (JSONB), like the DB itself is the trust boundary. Encrypting it at rest (e.g. AES-GCM keyed from `BETTER_AUTH_SECRET`) is a possible follow-up; not done.
- Vite dev proxy: `/api` is proxied with plain http-proxy, which streams SSE and does not need changes. Since the app is behind Traefik and Cloudflare, check once on the live site that events arrive without delay (the 15 s ping plus `X-Accel-Buffering: no` should be enough). Frontend note: `EventSource` reconnects on its own; on reconnect refetch the lists, because events missed while disconnected are not replayed.
- Inbound listener TLS handshake failures (bad CA etc.) are silent (no log line, nothing stored); only the client sees an error.
- Metrics: `channel_name` labels are cached from the DB and refreshed on every scrape, so a rename shows up on the next scrape. Inbound `AR` (DB insert failed) is counted in `ackwell_ack_failures_total` but has no message row.
- A TLS listener restored at boot uses the stored key; a channel with TLS enabled but missing material (impossible via API) would just start as plain TCP.
