# TLS test fixtures

TEST-ONLY certificates and private keys for `tls.e2e.test.ts`. Self-signed, valid for 100 years, never used
anywhere except automated tests. Do not use them for anything real.

- `ca.pem`: test CA; signed `server.pem` (SAN 127.0.0.1, localhost) and `client.pem`
- `wrong-ca.pem`: unrelated CA (used to prove verification fails)
- `server.key`, `client.key`: private keys of the test certificates (the CA keys were discarded)
