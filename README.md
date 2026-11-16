<p align="center">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/ackwell-logo-dark.svg" />
        <img alt="Ackwell" src="apps/web/public/brand/ackwell-logo.svg" width="260" />
    </picture>
</p>

<p align="center">
    A small, self-hosted HL7 v2 integration engine: MLLP in, lossless JSON out, signed webhooks, and JSON back to HL7
    with ACK tracking.
</p>

<p align="center">
    <a href="https://github.com/joemark0008/ackwell/actions/workflows/ci.yml"><img src="https://github.com/joemark0008/ackwell/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
    <img src="https://img.shields.io/badge/status-pre--1.0-orange" alt="Status: pre-1.0" />
</p>

---

Ackwell sits between systems that speak HL7 v2 (lab analysers, LIS, HIS, RIS) and applications that would rather speak
JSON over HTTP. An **inbound channel** listens for HL7 over MLLP, stores and ACKs every message, converts it to JSON
and delivers it to your webhook. An **outbound channel** takes HL7 or JSON from a REST call, builds the message,
sends it over MLLP in order and records the ACK. A web dashboard shows every channel and message as it happens.

## Features

- **Inbound MLLP channels**: a listener per channel on a port from a configured range. Every message is stored
  first, then ACKed (`AA` / `AE` / `AR`), so nothing is acknowledged that was not saved. Per-channel IP allowlist and
  optional TLS (with client certificates).
- **Lossless HL7 ↔ JSON**: a positional JSON form that rebuilds the original message byte for byte, for any HL7
  version, and a [typed "flat" JSON](docs/HL7-TYPED-JSON.md) with readable keys (`pid_5`, `msh_9_1`) and TypeScript
  types for 2.3, 2.5.1 and 2.7.
- **Signed webhooks**: delivery with retries and exponential backoff, signed per
  [Standard Webhooks](https://www.standardwebhooks.com/), with secret rotation and a choice of JSON format per channel.
- **Outbound channels**: `POST /api/channels/:id/send` with raw HL7 or JSON and a per-channel API key. Messages go out
  over MLLP (or TLS) in strict per-channel order, with ACK tracking and retries.
- **File transport**: channels can also use a shared folder: write outbound messages into `ORDER`, pick up inbound
  files from `RESULT` and move them to `PROCESSED` or `ERROR`.
- **Dashboard**: channel setup, start/stop, a live message feed (server-sent events), search and paging, raw HL7 beside
  JSON in a Monaco viewer, test-send, resend, API keys and webhook secrets.
- **Operations**: per-channel retention with an hourly cleanup job, `/health`, Prometheus `/metrics`, Swagger at
  `/api/docs`, graceful shutdown that finishes in-flight ACKs.

## Core technology stack

| Layer     | Technology                                                                                    |
| --------- | --------------------------------------------------------------------------------------------- |
| Runtime   | Node.js 22 (see `.nvmrc`), npm workspaces + Turborepo, TypeScript 5.9                          |
| API       | NestJS 12 (ESM) on Express, Zod-validated environment, nestjs-pino                            |
| Database  | PostgreSQL 16 with Drizzle ORM; pg-boss for delivery and retention queues                     |
| HL7       | `node-hl7-server` for listeners, raw `net`/`tls` MLLP sender, own lossless codec              |
| Auth      | Better Auth (email and password, no public sign-up), hashed per-channel API keys              |
| Frontend  | React 19, Vite, Tailwind 4, shadcn/ui, TanStack Query, React Router, react-hook-form, Monaco  |
| Testing   | Vitest (unit and API e2e with Testcontainers Postgres), Playwright (end-to-end)               |
| Deployment| Docker (a single image: the API also serves the built dashboard)                              |

## Repository layout

| Path                                   | Contents                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| [`apps/api`](apps/api)                 | NestJS API: channel manager, MLLP listeners and sender, delivery, retention   |
| [`apps/web`](apps/web)                 | React dashboard                                                               |
| [`packages/schemas`](packages/schemas) | Shared Zod schemas, the HL7 ↔ JSON codec and the typed flat JSON              |
| [`fixtures/hl7`](fixtures/hl7)         | Synthetic HL7 messages used by the tests                                      |
| [`e2e`](e2e)                           | Playwright flows against a running stack                                      |
| [`docs`](docs)                         | Design (`PLAN.md`), current state (`HANDOVER.md`), tracker and reports        |

## Installation

### Requirements

- Node.js **22** (`.nvmrc`; [nvm](https://github.com/nvm-sh/nvm) recommended) and npm 10
- Docker, for Postgres and for the API tests (Testcontainers)

### Local development

1. **Clone and configure the environment**

    ```bash
    git clone https://github.com/joemark0008/ackwell.git
    cd ackwell
    cp .env.example .env
    ```

    In `.env`, set `BETTER_AUTH_SECRET` (generate it with `openssl rand -base64 32`). The defaults fit the database
    below.

2. **Start Postgres**

    ```bash
    docker run -d --name ackwell-db -p 5432:5432 \
      -e POSTGRES_USER=ackwell -e POSTGRES_PASSWORD=ackwell -e POSTGRES_DB=ackwell postgres:16-alpine
    ```

3. **Install and run**

    ```bash
    nvm use
    npm install
    set -a && . ./.env && set +a   # the API reads plain environment variables (no dotenv)
    npm run dev
    ```

    Turborepo builds `packages/schemas` first, then runs the API in watch mode on `:3000` and Vite on `:5173`. Vite
    sends `/api`, `/health` and `/metrics` to the API. Migrations run when the API starts.

4. **Create the first admin**: open http://localhost:5173. On an empty database it shows a setup wizard. The API
   prints a one-time token in a box headed `Ackwell first-run setup`; enter it, choose the admin email and password,
   and you are signed in. The token changes on every restart and after five wrong attempts.

No Node on your machine? `docker compose up` runs the same dev setup (with hot reload) in a `node:22-alpine`
container; pass `DATABASE_URL` and `BETTER_AUTH_SECRET` in the environment. See the comments in
[`docker-compose.yml`](docker-compose.yml).

### Production with Docker

[`docker-compose.prod.yml`](docker-compose.prod.yml) builds a single image (the API serves the built dashboard) and
runs it with its own Postgres.

1. **Configure**

    ```bash
    cp .env.example .env
    ```

    Set these values:
    - `BETTER_AUTH_SECRET`: required; keep it the same across restarts.
    - `POSTGRES_PASSWORD`: required.
    - `APP_URL`: the public URL users open, for example `https://ackwell.example.com`. Sign-in checks the request
      origin against it.
    - `MLLP_ADVERTISED_HOST`: the host or IP that HL7 senders connect to, shown in the dashboard.
    - Optional: `ACKWELL_PORT` for the dashboard's host port (default `8080`), `MLLP_BIND_IP` to publish the MLLP range
      on one address only, and `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` to skip the setup wizard.

2. **Start**

    ```bash
    docker compose -f docker-compose.prod.yml up -d --build
    ```

    The container applies pending database migrations each time it starts. Put a reverse proxy that handles TLS in
    front of the dashboard port. The image is also published as `ghcr.io/joemark0008/ackwell`.

3. **Create the first admin**: open your public URL and enter the setup token from the log:

    ```bash
    docker compose -f docker-compose.prod.yml logs ackwell | grep -A3 "first-run setup"
    ```

**MLLP and networking.** HL7 over MLLP is raw TCP, so it cannot go through an HTTP reverse proxy or a CDN. The compose
file publishes the whole `MLLP_PORT_RANGE` (default `6100-6150`) directly; keep it on a private network or bind it to
a LAN address with `MLLP_BIND_IP`. Run **one replica**: each listener owns its port.

Data lives in two volumes: `ackwell_postgres_data` (the database) and `ackwell_files` (the shared folder for
file-transport channels; mount a real share there instead if you use them). Back up the database.

## Configuration

`.env.example` lists every variable, and [`apps/api/src/config/env.ts`](apps/api/src/config/env.ts) validates them at
startup.

| Variable                                  | Purpose                                                                   | Default                 |
| ----------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| `DATABASE_URL`                            | Postgres for app data and pg-boss                                         | required                |
| `BETTER_AUTH_SECRET`                      | Session signing secret, 32+ characters                                    | required                |
| `APP_URL`                                 | Public base URL (trusted origin for sign-in)                              | `http://localhost:3000` |
| `PORT`                                    | API HTTP port                                                             | `3000`                  |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`| Unattended first admin; unset = setup wizard                              | unset                   |
| `MLLP_PORT_RANGE`                         | Ports inbound channels may listen on                                      | `6100-6150`             |
| `MLLP_ADVERTISED_HOST`                    | Host shown to senders in the dashboard                                    | `localhost`             |
| `MLLP_BIND_ADDRESS`                       | Address the listeners bind to                                             | `0.0.0.0`               |
| `FILE_ROOT`                               | Shared folder for file-transport channels; unset = disabled               | unset (`/data/files` in the image) |
| `RETENTION_DEFAULT_DAYS`                  | Default message retention                                                 | `7`                     |
| `DELIVERY_RETRY_DELAY_SECONDS`            | Webhook retry base delay (exponential, max 10 min)                        | `10`                    |
| `QUEUE_POLL_SECONDS`                      | pg-boss poll interval                                                     | `2`                     |
| `METRICS_TOKEN`                           | When set, `/metrics` requires `Authorization: Bearer <token>`             | unset (open)            |
| `LOG_LEVEL`                               | Pino log level                                                            | `info`                  |
| `WEB_DIST`                                | Folder of the built dashboard the API serves                              | `apps/web/dist`         |

## Try it with HL7

**Inbound.** Create an inbound channel in the dashboard, pick a port in the range, add the sender's IP (or CIDR) to the
allowlist and start it. Then send a message with HL7 Soup, `mllp_send`, or this snippet:

```python
import socket
msg = "MSH|^~\\&|SENDER|LAB|ACKWELL|LAB|20260101120000||ORU^R01|MSG0001|P|2.5\rPID|1||12345||DOE^JOHN\r"
s = socket.create_connection(("localhost", 6100))
s.sendall(b"\x0b" + msg.encode() + b"\x1c\x0d")
print(s.recv(4096))   # MSH...|ACK^R01|...\rMSA|AA|MSG0001
```

A sender outside the allowlist is disconnected straight away, so the client sees no response; the API log shows
`Rejected connection from <ip> ... (not in allowlist)`.

**Outbound.** Create an outbound channel with the target host and port, create an API key on its page, then:

```bash
curl -X POST http://localhost:5173/api/channels/<id>/send \
  -H "Authorization: Bearer ak_..." -H "Content-Type: text/plain" \
  --data-binary $'MSH|^~\\&|ACKWELL|LAB|LIS|LAB|||ORM^O01|ORD0001|P|2.5\rPID|1||12345||DOE^JOHN'
```

**Verifying webhooks.** Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/): headers
`webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,<base64>`). The signed content is
`${id}.${timestamp}.${body}`, with HMAC-SHA256 keyed by the base64-decoded secret after its `whsec_` prefix. During a
secret rotation two signatures are sent. Reject timestamps older than 5 minutes.

## Development checks

```bash
npm run typecheck
npm test            # schemas unit tests, API e2e (Postgres via Testcontainers), web component tests
npm run db:generate -w @ackwell/api -- --name <change>   # after editing apps/api/src/db/schema.ts
```

The API e2e tests bind MLLP listeners on ports 6010-6050, so keep those free. The Playwright flows in
[`e2e/`](e2e/README.md) run against a local stack.

[CI](.github/workflows/ci.yml) runs typecheck and the tests on every pull request and push to `main`, then builds the
Docker image. Pushes to `main` and version tags (`v*`) publish it to `ghcr.io/joemark0008/ackwell`.

## Brand

[`apps/web/public/brand/`](apps/web/public/brand) holds the mark, light and dark logos and a social card. Brand teal is
`#00978a` (dark theme `#26bdae`).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities privately.

### Contributors

<a href="https://github.com/joemark0008/ackwell/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=joemark0008/ackwell" alt="Contributors to Ackwell" />
</a>

## Disclaimer

Ackwell moves clinical messages but is not a certified medical device. Test it with your own systems before you rely
on it, and never use real patient data in issues, fixtures or screenshots.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
