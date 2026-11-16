# Contributing to Ackwell

Thanks for your interest. Bug reports, fixes, features and documentation are all welcome.

## Before you start

- Read [docs/PLAN.md](docs/PLAN.md) (the design) and [docs/HANDOVER.md](docs/HANDOVER.md) (where things stand and
  the decisions behind them).
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setup

Follow [Local development](README.md#local-development) in the README. You need Node 22, npm 10 and Docker (the API
tests start Postgres with Testcontainers).

## Rules the code follows

- **Store first, then ACK.** An inbound message is saved before the sender gets its ACK; never ACK what was not saved.
- **Shared Zod schemas** in `packages/schemas` validate both the API and the web forms; change them there, not twice.
- **The HL7 ↔ JSON codec is lossless.** Every change keeps the round trip exact (`hl7-fixtures.test.ts`).
- **Database changes go through Drizzle migrations** (`npm run db:generate -w @ackwell/api -- --name <change>`);
  never edit an existing migration.
- **Tests come with every change**: unit tests next to the code, API e2e tests in `apps/api/test`.
- **Never commit real data or secrets**: no real patient messages in fixtures, screenshots or issues, and no keys or
  passwords. Use the synthetic messages in `fixtures/hl7`.

## Checks

Before you open a pull request:

```bash
npm run typecheck
npm test
```

The API e2e tests bind MLLP listeners on ports 6010-6050, so keep those free. For UI flows, the Playwright suite in
[`e2e/`](e2e/README.md) runs against a local stack.

CI runs typecheck and the tests on every pull request and builds the Docker image.

## Pull requests

- Keep each pull request to one change, with tests.
- Write the commit message as what the change does ("Show the ACK code in the message log").
- By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
