## Task
Phase 7 frontend: SSE live events replacing polling, global Messages page, Monaco HL7/JSON viewer.

## What changed (files / routes / components)
- `apps/web/src/lib/live-state.ts` (new): tiny external store `live | reconnecting | off` + `useLiveStatus()`.
- `apps/web/src/lib/live.ts` (new): `startLiveEvents(qc, opts)` / `useLiveEvents(qc)` (mounted once in `AppShell`, so not on login/setup), `applyMessageEvent`, `applyChannelStatus`.
- `apps/web/src/lib/queries.ts`: `LogFilters` type (local `MessageListQuery & {channelId?, direction?}`; switch to `GlobalMessageListQuery` when it is exported, it was not in `@ackwell/schemas` yet), `keys.allMessages(filters)` = `['messages','all',filters]`, `useAllMessages`, `useMessages` polls (4 s) only while the stream is not `live`; resend also invalidates the global list.
- `apps/web/src/lib/api.ts`: `api.messages.list(query)` -> `GET /api/messages`.
- `apps/web/src/components/message-log.tsx` (new): shared table + filters + "Load older" + dialog. Props: `useData(filters)`, `scope` (global mode: Channel column with link + direction badge, channel and direction selects), `empty`, `hint`.
- `apps/web/src/components/messages-card.tsx`: now a thin card around `MessageLog`; indicator shows "Live" only when running and stream live, otherwise "Refreshing periodically" / "Reconnecting, ...".
- `apps/web/src/pages/messages.tsx` (new) + route `/messages` in `router.tsx`; `app-shell.tsx` NavItem lost the `soon` prop (real link).
- Monaco: `components/code-editor.tsx` (lazy default export), `lib/monaco-setup.ts` (workers, `hl7` Monarch language, light/dark themes, `loader.config({monaco})`), `src/monaco.d.ts` (type shim). `message-dialog.tsx` uses `React.lazy` + `Suspense` with the old `<pre>` as fallback; only one layout (side by side >= 1024px, tabs below) is mounted so only visible editors exist.
- Tests: fixtures in `api-keys-card.test.tsx`, `channels-list.test.tsx`, `channel-form.test.ts` fixed (outbound `tls.rejectUnauthorized` is now required by the schema; typecheck was failing before my change). `test/setup.ts`: jsdom polyfills for Radix Select.

## API endpoints & SSE events consumed
- `GET /api/events` (EventSource, optional `?channelId` not used by the web app): `message` (MessageSummary), `channel.status` (`{channelId,status,error?}`). Verified on the dev server that the route exists (401 without a session).
- `GET /api/messages?limit&cursor&status&q&channelId&direction`, plus existing `/api/channels`, `/api/channels/:id/messages`, `/api/messages/:id`, resend.

### How the live hook updates caches
On `message`: every cached query whose key is `['channels', id, 'messages', filters]` or `['messages','all',filters]` is patched with `setQueryData` (no refetch). If the id is already on a loaded page the row is replaced (or removed with total-1 when it no longer matches the filters). Otherwise, if it matches (channel scope, channelId, direction, status, q prefix on type/control id) it is prepended to page 1 and `total` + 1. `['messages', id]` is invalidated only if that detail query exists. On `channel.status` the status is patched in `['channels', id]` and `['channels']`. On error: state becomes `reconnecting`; while the browser retries by itself nothing else happens; if the source is CLOSED (HTTP error) we probe `/api/settings`: 401 stops (`off`), otherwise reconnect with exponential backoff 1 s to 30 s. After any reconnect the channel list and all message lists are invalidated to catch up missed events.

### Monaco bundling
Local only: `editor.api` + folding, find, clipboard, bracket matching, word highlighter + JSON language service; workers via Vite `?worker` (`editor.worker`, `json.worker`); `loader.config({ monaco })` so `@monaco-editor/loader` never fetches from a CDN. Editors read-only; JSON has folding; theme follows `next-themes` (`ackwell-light` / `ackwell-dark`, vs and vs-dark based).
`vite build` (gzip): main `index` 1,112 kB (326 kB), unchanged in kind and contains no Monaco; lazy `code-editor` chunk 3,002 kB (770 kB) + `jsonMode` 987 kB (254 kB) + workers 304 kB and 433 kB + CSS 125/61 kB + codicon.ttf 153 kB, all loaded only when a message dialog opens. The lazy chunk contains the string `cdn.jsdelivr` from the loader default config; it is not used because `monaco` is passed in (worth a Playwright network check for any external request).

## How to verify
Log in, open `/messages` (sidebar link), send a message to an inbound channel: the row appears at the top without reload; filter by channel/direction; open a row: Monaco panes with HL7 colouring (segment names, `|^~&` delimiters) and folded-capable JSON; toggle theme. Stop the API: indicator changes to reconnecting/periodic refresh and polling resumes. I did not run a browser check.

## Tests (command + result)
`docker exec app-d3tdtacn0nqgdnanacqwv1pt sh -c "cd /app && npm run build -w @ackwell/schemas && npx turbo run test typecheck --filter=@ackwell/web"`: 8 files, 26 tests passed (was 4 files / 14 before my additions; new: 6 live-hook tests, 3 Messages page tests, 1 card fallback test); typecheck clean; `vite build` OK. No lint script exists.

## Open issues / questions for the lead
- `globalMessageListQuerySchema` not in `@ackwell/schemas` yet; `LogFilters` in `lib/queries.ts` is the local stand-in (swap when exported).
- Vite dev proxy for `/api/events` left as is (no config change needed; unauthenticated request got 401 through the proxy). Authenticated streaming not verified by me.
- Whole `monaco-editor` main entry was avoided to save weight; if a Monaco feature looks missing in the browser, add its contribution import in `monaco-setup.ts`.
- Not done by me (outside `apps/web`): tick of NEXT.md item 11.

## Follow-up (backend TLS schema, 2026-11-11)
- Channel form: inbound TLS shows Certificate, Private key, optional CA (PEM textareas) and a "Require client certificate" switch; outbound TLS shows optional CA and a "Verify the target certificate" switch (`rejectUnauthorized`, default off, help "Off accepts self-signed certificates"). TLS off still sends `{ enabled: false }`. On edit the key field is empty; with `hasKey` it says a key is stored and the key is sent only if typed (the resolver validates as if the stored key were present). cert/ca are prefilled from the loaded channel so PATCH re-sends them; `hasKey` is never sent. Server 400 paths `config.tls.cert|key|ca|requestCert|rejectUnauthorized` map to the new fields. Files: `lib/channel-form.ts`, `pages/channel-form.tsx`.
- Detail page configuration card: "On, client cert required/optional, key stored" (inbound) or "On, target certificate verified/not verified" (outbound). The key is never rendered; the flow preview only uses host/port/url.
- `LogFilters` now derives from the shared `GlobalMessageListQuery`; `api.messages.list` uses it.
- Live hook: on a reconnect (reconnecting -> live) it invalidates `['channels']` (list and all channel caches, including `['channels', *, 'messages']`) and `['messages','all']`; not on the first connect.
- Tests: web 8 files, 33 tests pass (new: 6 TLS form cases, 1 reconnect case); typecheck clean.
