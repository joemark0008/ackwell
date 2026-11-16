# File transport (shared folder) — BUILT 2026-11-11

Status: **built, tested and live on the dev service** (2026-11-11). The MLLP channels are unchanged; this adds a
second way for a channel to connect. The plan below is kept; where the build differs, the **As built** notes win.

## As built (2026-11-11)

- **Config:** there is no separate `extension` field; the extension is part of `fileName` (it must end in one).
  `segmentSeparator` is stored as `'CR' | 'CRLF' | 'LF'` (default `CR`); every segment, including the last, ends
  with it. File-name tokens: `{messageType} {trigger} {controlId} {timestamp} {date} {seq} {id}`; unsafe characters
  in values become `_`, an empty value becomes `NA`. Folder fields are relative (no `..`, no leading `/`, no hidden
  segments); inbound needs three different folders, and `PROCESSED`/`ERROR` may not sit inside the watched folder.
- **Outbound write:** `FILE_ROOT/.ackwell-tmp/<uuid>.part` (`wx`, fsync, size check) → `link()` into `ORDER`
  (never overwrites; `_1`, `_2`… or fail per `onExists`), fallback `rename` after an existence check when the share
  has no hard links. The staging copy is removed. The attempt row says `Wrote ORDER/<name> (<n> bytes)`; the message
  becomes `sent` with no ACK and `sourceFile` = the written path. Share errors use the channel's retry settings.
- **Inbound:** one chokidar 6 watcher per channel (`depth: 0`, polling by default), a serial queue, and a full
  re-scan every 60 s (also the health check: an unreachable folder sets the channel to `error`, recovery sets it back
  to `running`). A file is read only after `stableMs` without change and is re-checked after reading. sha256
  duplicates are recorded as `duplicate` and moved to `PROCESSED` without a new message. Rejected files go to `ERROR`
  with `<name>.error.txt` (`File:`, `Reason:`, `Channel:`, `Channel-Id:`, `Time:` lines).
- **Same filesystem:** on start, Ackwell checks that the folders and the staging folder are on one device
  (`409 FOLDER_UNAVAILABLE` otherwise); this is why only the root is mounted.
- **API:** `POST /api/channels/check-folder` `{directory}` (creates nothing) · `GET /api/channels/:id/files/errors` ·
  `POST /api/channels/:id/files/errors/:name/retry` (moves the file back into the watched folder; channel must run).
  Errors: `FILES_DISABLED` (no `FILE_ROOT`), `FOLDER_IN_USE` (another inbound file channel watches it),
  `FOLDER_UNAVAILABLE`. `/api/settings` has `files.enabled`.
- **Data:** `channels.transport` (`mllp` default), `messages.source_file`, table `file_imports` (migration
  `0005_file_transport`). Retention deletes old files in `PROCESSED` along with their `file_imports` rows
  (`filesDeleted` in the run result), using the import time, not the file time.
- **Metrics:** one counter `ackwell_files_total{channel_id,outcome}` (`imported` / `duplicate` / `error` / `written`).
- **UI:** create form has a Connection type choice (MLLP · Shared folder; disabled without `FILE_ROOT`), folder
  fields with a Check button, file-name presets and a live preview; the channel page shows the folders and settings,
  and an **Error files** card with Retry on inbound file channels; the message log shows the file name in From/To.
- **Deployment (dev):** host folder `/mnt/hl7share` → container `/data/files` (`rslave`), `FILE_ROOT=/data/files`.
  Mount the real share on the host at `/mnt/hl7share` (e.g. CIFS/NFS in `/etc/fstab`); `rslave` lets a share
  mounted later appear in the running container. Until then it is an empty local folder.
- **Tests:** schemas `file-transport.test.ts` (8), API `files.e2e.test.ts` (16), web channel-form (3) + error card (3).

## 0. Decisions (user, 2026-11-11)

- **Separate folders**, four of them: **`ORDER`**, **`RESULT`**, **`PROCESSED`**, **`ERROR`**.
- **One message per file.** A result file with more than one MSH is not split: it goes to `ERROR` with the reason.
- **After pickup: move** the file to `PROCESSED` (never delete).

Folder layout under `FILE_ROOT` (the mounted share), defaults; each name can be changed per channel:

```
FILE_ROOT/
├── ORDER/       outbound channel writes order files here            → LIS reads them
├── RESULT/      LIS writes result files here                       → inbound channel watches it
├── PROCESSED/   inbound channel moves a result here after import (audit trail)
└── ERROR/       inbound channel moves unreadable / invalid / multi-message results here,
                 with <file>.error.txt beside each one
```

## 1. What it does

Some systems do not speak MLLP; they exchange `.hl7` files through a shared folder.

```
 HIS ──POST /send (hl7 | json | flat)──▶ Ackwell ──writes ORM .hl7──▶ ORDER/          ──▶ LIS reads (out of scope)
                                                                                                    │
 HIS ◀──signed webhook (json + flat)── Ackwell ◀──picks up ORU .hl7── RESULT/         ◀── LIS writes (out of scope)
                                               └──moves the file──▶ PROCESSED/  or  ERROR/ (+ .error.txt)
```

| Channel | Today (MLLP) | New (file) |
|---|---|---|
| **Outbound** (orders) | queue → MLLP to host:port → wait for ACK | queue → **write a file** into a folder → done |
| **Inbound** (results) | MLLP listener on a port → ACK | **watch `RESULT`** → read each new file → store → deliver (webhook) → move it to `PROCESSED` (or `ERROR`) |

Everything after the transport is shared: message log, raw + lossless JSON + typed flat JSON, webhook delivery,
retries, resend, retention, SSE live view, metrics, API keys.

## 2. Data model

- `channels.transport`: new enum column `'mllp' | 'file'`, **default `'mllp'`**, so every existing channel keeps
  working unchanged (migration only adds the column).
- `config` stays a jsonb column; its shape now depends on direction **and** transport (discriminated unions in
  `packages/schemas/src/channel.ts`; the existing MLLP schemas are reused untouched).
- The unique "one inbound listener per port" index is narrowed to `transport = 'mllp'`.
- `messages.source_file` (nullable text): file name a message came from / was written to. Shown in the UI
  "From"/"To" column instead of the remote IP.
- `file_imports` (new, inbound file only): `channel_id, file_name, size, mtime, sha256, status, error, created_at`,
  unique on `(channel_id, sha256)` so a file is never imported twice (crash between "stored" and "moved", or
  the same file dropped again).

### Outbound file config

```ts
{
  directory: 'ORDER',                // relative to FILE_ROOT (see §5); created if missing
  // File name: pick a preset in the UI or type a custom pattern. Tokens:
  //   {messageType} ORM   {trigger} O01   {controlId} AW1A2B3C   {timestamp} 20261111143005
  //   {date} 20261111     {id} message uuid   {seq} per-channel counter (000001…)
  // Presets: '{messageType}_{controlId}.hl7' (default) · '{controlId}.hl7' ·
  //          '{messageType}_{trigger}_{timestamp}_{controlId}.hl7' · '{date}_{seq}.hl7'
  // Validation: must produce a plain file name (no / \ : * ? " < > |), must end in an extension.
  fileName: '{messageType}_{controlId}.hl7',
  segmentSeparator: 'CR',            // 'CR' (HL7 standard, default) | 'CRLF' | 'LF'
  encoding: 'utf8',                  // 'utf8' | 'latin1'
  onExists: 'suffix',                // 'suffix' (_1, _2…) | 'fail' — never overwrite silently
  retry: { maxAttempts, backoffSeconds }   // same shape as MLLP (share offline, permission denied…)
}
```

### Inbound file config

```ts
{
  directory: 'RESULT',               // watched folder, relative to FILE_ROOT
  processedDirectory: 'PROCESSED',   // imported files are moved here (same name; _1, _2… on a clash)
  errorDirectory: 'ERROR',           // invalid files are moved here with <name>.error.txt beside them
  include: ['*.hl7'],                // glob patterns (case-insensitive); decided: .hl7 only
  stableMs: 2000,                    // file must stop growing this long before it is read (see §3a)
  pollIntervalMs: 2000,              // network shares need polling (see §4)
  usePolling: true,
  encoding: 'utf8',
  // one message per file: a file with 0 or several MSH segments goes to ERROR
}
```

## 3a. Only finished files (decided)

Rule (user, 2026-11-11): **a `.hl7` file only ever appears when it is completely written.** No marker files,
no partial files, nothing for the LIS to configure.

**Ackwell writing orders (`ORDER`)**
1. Write the whole message to a staging folder **outside** `ORDER`: `FILE_ROOT/.ackwell-tmp/<uuid>.part`.
2. Flush it to disk (`fsync`) and check the size on disk equals the bytes written.
3. `rename` it into `ORDER/<final name>.hl7`.

`rename` on the same filesystem is atomic: the file appears in `ORDER` all at once, already complete. Because
the staging file lives outside `ORDER`, the LIS never sees it, even if it picks up every file in the folder
regardless of extension. One root mount (§5) keeps staging and `ORDER` on the same filesystem; Ackwell checks
this at start and refuses to run the channel (clear error) if they are not.

**Ackwell reading results (`RESULT`)**
Ackwell cannot control how the LIS writes, so it makes sure the file is finished before reading it:
1. Wait until the file's size and modified time have not changed for `stableMs` (default 2 s; chokidar
   `awaitWriteFinish`).
2. Read it and check it is one complete message (starts with `MSH`, exactly one `MSH`, parses).
3. If it fails because it was still being written (the size changed between the check and the read) →
   leave it and try again on the next scan; only a file that is stable *and* invalid goes to `ERROR`.

If the LIS already writes to a temp name and renames (many do), its files are complete the moment they
appear, and the 2 s wait just adds a short delay. Marker files (`.ok`) could be added later as an option if a
specific LIS requires them; not planned.

## 3. Outbound flow (Ackwell writes the order file)

1. `POST /api/channels/:id/send` — **unchanged** (raw HL7, lossless JSON or `{ flat }`, API key or session).
   MSH-7 / MSH-10 / MSH-12 filled in as today.
2. Same pg-boss outbound queue, strict FIFO per channel. The worker picks the sender by `transport`:
   `MllpSender` (today) or new `FileWriter`.
3. `FileWriter`: build the HL7 text with the configured segment separator → write and `fsync` to
   `FILE_ROOT/.ackwell-tmp/<uuid>.part` → **`rename`** to `ORDER/<name>.hl7` (§3a). The LIS only ever sees
   finished `.hl7` files.
4. Status: the rename succeeding = `sent` (no ACK exists in this transport; `ackCode` stays null, attempt
   response = written path + bytes). Errors (share offline, EACCES, disk full) → retry with backoff →
   `failed` after `maxAttempts`, exactly like MLLP. Resend writes a new file.

## 4. Inbound flow (Ackwell picks up the result file) — chokidar

`InboundFileWatcher`, one per running channel, managed by the existing `ChannelManager` next to the MLLP
listeners (start/stop from the UI, restored on boot).

**chokidar 6** (`npm i chokidar@6`; ESM, Node ≥ 22.22 — the dev container has 22.23.4, the production
Dockerfile must pin `node:22` ≥ 22.22):

```ts
watch(dir, {
  depth: 0,                                     // only RESULT itself
  ignored: (p, s) => s?.isFile() && !matches(include, p) || basename(p).startsWith('.'),
  ignoreInitial: false,                         // files already waiting at start are imported (backlog)
  usePolling: cfg.usePolling, interval: cfg.pollIntervalMs,
  awaitWriteFinish: { stabilityThreshold: cfg.stableMs, pollInterval: 500 },
});
```

Why these options:
- **Polling**: inotify only reports changes made by *this* machine. Files written by the LIS from another
  machine onto an SMB/NFS share produce no events, so `usePolling: true` is the safe default for shares.
- **awaitWriteFinish**: waits until size/mtime stop changing, so a file still being copied is not read early.
- chokidar's `add` events are the trigger, plus a **rescan every N minutes** as a safety net (missed events,
  watcher restarted after a share outage).

Per file, serially per channel (oldest first):
1. Read → sha256 → if already in `file_imports` → just move it to `PROCESSED` (duplicate), done.
2. Check **exactly one MSH** (one message per file), then parse with the existing codec.
3. In one DB transaction: insert the message (`direction: 'inbound'`, `status: 'received'`, `source_file`)
   + the `file_imports` row. Queue the delivery job (existing webhook adapter: `json` + `flat`).
4. Only after the commit: move the file to `PROCESSED`. If the move fails the file is retried on the next
   scan and skipped as a duplicate by its hash.
5. Unreadable, no MSH, several MSH, or unparsable → move to `ERROR` with `<name>.error.txt` (reason, time,
   channel), store an import row with the error, show it in the UI ("Retry" moves it back to `RESULT`).
   No ACK file is written (the LIS is out of scope; can be added later as an option).

Moves use `rename` (atomic when `RESULT`, `PROCESSED` and `ERROR` are on the same share, which they are
under one `FILE_ROOT`). `PROCESSED` files are deleted by the existing retention job after the channel's
retention days; `ERROR` files are kept until someone handles them.

Channel health: watcher `error` (folder missing, permission denied, share disconnected) → channel status
`error` with the reason in the UI and logs; the watcher keeps retrying and returns to `running` when the
folder is reachable again.

## 5. The shared folder on the server (deployment)

The container can only see folders that are mounted into it:

Decided: the user mounts the share on the server themselves (any kind: SMB, NFS or local) and bind-mounts it
into the container. Ackwell needs no share credentials; it only sees `FILE_ROOT`.

1. **Host**: mount the share once, e.g. SMB from the Windows file server via `/etc/fstab`
   (`//fileserver/hl7  /mnt/hl7share  cifs  credentials=/root/.smb-hl7,uid=1000,gid=1000,iomode…  0 0`),
   or NFS, or a plain local folder if HIS/LIS reach this server's folder instead.
2. **Coolify service** (`docker-compose.yml`): add **one** bind mount for the root only,
   `- /mnt/hl7share:/data/files`, and the env `FILE_ROOT=/data/files`. The four folders are not mounted
   separately: they are subfolders of the root, and Ackwell creates `ORDER`, `RESULT`, `PROCESSED` and `ERROR`
   when a channel starts if they are missing. One mount also keeps every move a same-filesystem `rename`. Done through Coolify like every other change (rule from the server deployment rules (`docs/local/SERVER.md`, not published)).
3. **Safety**: channel `directory` values are relative to `FILE_ROOT`; the API resolves `realpath` and rejects
   anything outside it (`..`, absolute paths, symlinks out). Two channels cannot use the same inbound folder.
   The UI shows "folder reachable / not reachable / not writable" when a channel is saved and started.

## 6. API and UI

- `POST /channels` / `PATCH`: `transport: 'file'` + file config. Existing bodies without `transport` mean `mllp`.
- `POST /channels/:id/check-folder` → exists / readable / writable / file count (for the form's "Test" button).
- Channel form: a **Connection type** choice (MLLP · Shared folder) per direction; the MLLP form is unchanged.
- Channel page: Connection card shows the folders (`ORDER` / `RESULT` → `PROCESSED` / `ERROR`), file-name
  pattern, a flow diagram, last pickup / last write, and for inbound the `ERROR` files with their reasons
  (with "Retry" = move back into `RESULT`).
- Message log: "From"/"To" shows the file name; the message viewer is unchanged (raw / typed / lossless).
- Metrics: `ackwell_files_imported_total`, `ackwell_files_failed_total`, `ackwell_files_written_total`.

## 7. Tests

- Schemas: config validation, path rules, file-name tokens.
- API e2e (temp dir as `FILE_ROOT`):
  - outbound: send → file appears with the right name/separator; `ORDER` never shows a partial or temp file (watched during the write), staging folder empty afterwards; share missing → retries →
    `failed`; name clash → `_1` suffix.
  - inbound: drop a file in `RESULT` → webhook receives `json` + `flat` → file moved to `PROCESSED`; slow
    write (append in chunks) is not read early; file with two MSH → `ERROR` + reason; bad file → `ERROR` +
    reason; Retry moves it back and imports it; same file again → not imported twice; files present before
    start are imported; stop → no pickups; polling mode works; retention cleans old `PROCESSED` files.
  - existing MLLP tests unchanged (regression).
- Web: form switch MLLP ↔ folder, connection card.
- Live: real share mounted on the dev server, LIS-style test files.

## 8. Build order (when approved)

1. Schemas + migration (`transport`, `source_file`, `file_imports`), `FILE_ROOT` env + path guard.
2. Outbound `FileWriter` behind the existing worker + tests.
3. Inbound `InboundFileWatcher` (chokidar) in `ChannelManager` + import pipeline + tests.
4. UI (form, connection card, error files) + tests.
5. Deployment: mount the share on the host, add the volume + `FILE_ROOT` to the Coolify service, live check.

## 9. Decisions log (user, 2026-11-11)

- Folders: `ORDER`, `RESULT`, `PROCESSED`, `ERROR` under one mounted root (`FILE_ROOT`); only the root is mounted.
- Share: any kind; the user mounts it on the server and into the container. Ackwell holds no share credentials.
- Order file name and segment separator: **configurable per channel** (presets + custom pattern; CR/CRLF/LF).
- Completion: **only finished `.hl7` files** — orders staged outside `ORDER` and renamed in; results read only
  after they stop changing and parse as one message (§3a). No marker files.
- Result files: one message per file, `.hl7` only, moved to `PROCESSED` (never deleted on pickup).
- Priority: **recommended order** — build the file transport now, **before Phase 8 QA** (so QA covers both
  transports in one pass) and **before Phase 9 production** (the production Dockerfile/compose then includes
  the `FILE_ROOT` mount from the start instead of being changed again).

No open questions. Next step: build (§8) when the user says go.
