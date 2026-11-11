# Phase 6 — Retention (hourly cleanup job)

**Date:** 2026-11-11 · **By:** main session · **Status:** done, live on dev

## Task
Delete messages older than each channel's `retentionDays` (default from `RETENTION_DEFAULT_DAYS`) on an hourly
schedule, in batches, never touching messages still pending delivery, send or retry.

## What changed (files)
- `packages/schemas/src/retention.ts` — **new** `RETENTION_PROTECTED_STATUSES` (`received`, `queued`, `processing`),
  `retentionRunSchema`, `retentionStatusSchema`.
- `apps/api/src/retention/retention.service.ts` — **new** `RetentionService`: pg-boss queue `retention`
  (policy `singleton`, so two runs never overlap), schedule `0 * * * *` UTC registered on boot, worker runs the
  cleanup; `run()` shares an in-flight run; per channel: `DELETE … WHERE id IN (SELECT … LIMIT 1000)` looped
  until a batch comes back short; `delivery_attempts` go by cascade; last run kept in memory.
- `apps/api/src/retention/retention.controller.ts`, `retention.module.ts` — routes below; `app.module.ts` wired.
- `apps/web/src/pages/channel-detail.tsx` — Retention row explains the hourly cleanup.
- `apps/api/test/retention.e2e.test.ts` — **new** (4 tests).

## Endpoints / schemas added or changed
| Method | Path | Notes |
|---|---|---|
| GET | `/api/retention` | `{ cron, batchSize, protectedStatuses, lastRun, nextRunAt }` |
| POST | `/api/retention/run` | runs the cleanup now; returns `{ startedAt, finishedAt, durationMs, deleted: { channelId: n }, total, trigger }` |

Both need a session. The cutoff is `now − retentionDays` on `messages.created_at`.

## Migrations
None (pg-boss stores the schedule in `pgboss.schedule`).

## Tests (command + result)
Same command as before.
- retention e2e 4/4: schedule registered + status; per-channel cutoffs (1-day channel: 2/3-day-old
  delivered/failed deleted, 5-day-old received/processing kept, half-day-old kept; 30-day channel: 31-day-old sent
  deleted, 2-day-old sent and 40-day-old queued kept) with attempts cascading; 2,350 expired rows deleted across
  three batches; 401 without a session.
- Full suite: schemas 21/21 · **API 54/54** · web 14/14 · typecheck clean · `vite build` OK.
- Live (dev): after restart, `Retention schedule "0 * * * *" (UTC) registered`; `GET /api/retention` → next run
  06:00 UTC; `POST /api/retention/run` → 0 deleted (nothing older than 7 days); `pgboss.schedule` has the row.

## Decisions
- Protected statuses are `received`, `queued`, `processing` (pending delivery/send/retry); `delivered`, `sent`,
  `rejected`, `failed` are deletable once expired.
- The schedule is UTC. The run summary lives in memory (lost on restart); pg-boss keeps job history for 7 days.

## Open issues
- No UI for the global retention status / "run now" yet (API only). Could go on a future Settings page.
