# Security policy

Ackwell receives and sends clinical HL7 messages, which usually contain patient data, so we take security reports
seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/joemark0008/ackwell/security/advisories/new).

Please include what you found, how to reproduce it (with the synthetic messages in `fixtures/hl7` or other test data),
and the impact you expect. We aim to acknowledge a report within 5 working days and to agree a disclosure date with you
once a fix is ready.

## Scope

In scope: the code in this repository (`apps/api`, `apps/web`, `packages/schemas`), its Docker image and its default
configuration. Of particular interest:

- reaching the dashboard or the REST API without a session, or the send endpoint without a valid channel API key;
- an MLLP sender getting past a channel's IP allowlist, or crashing or stalling other channels;
- forging or replaying webhook deliveries that pass signature verification;
- reading messages, API keys or webhook secrets through the API or UI after they were first shown (API keys are
  stored as hashes; webhook secrets are shown once and never returned again);
- file-transport channels reading or writing outside `FILE_ROOT`;
- the first-run setup token or the setup endpoints letting someone create an admin on an installed system.

Out of scope: vulnerabilities in a deployment you do not own, social engineering, and denial of service by volume.

## Supported versions

Ackwell is pre-1.0. Only the latest `main` receives security fixes.

## Never use real patient data

Do not test against, or attach, real patient or production messages in a report. Use the synthetic messages in
`fixtures/hl7`.
