# LNURL Doctor

A CLI and library for diagnosing Lightning addresses and LNURL-pay endpoints.
It resolves the address, requests an invoice, and explains what passed, what
failed, and what to change. It never pays the invoice or sends a zap.

## Install and run

Requires Node.js 18+ (18.18+ when building from GitHub or developing locally).

```sh
npx github:piolpro/lnurl-doctor hello@getalby.com
npx --yes github:piolpro/lnurl-doctor#v0.1.0 hello@getalby.com --amount 10 --json
npm install github:piolpro/lnurl-doctor#v0.1.0
```

```text
lnurl-doctor <address|lnurl> [--amount sats] [--json] [--timeout ms] [--check-out-of-range]
```

- Accepts `user@domain`, a bech32 `lnurl1…`, or a `lnurlp://…` URI, with an optional `lightning:` prefix.
- By default requests the smallest whole-sat amount in the advertised range.
  `--amount` accepts sats with up to three decimal places (e.g. `1.501`).
- `--timeout` sets a per-request timeout, including redirects and reading the body (default: 5000 ms).
- `--json` emits structured checks. The default human report uses colors only on a TTY; set `NO_COLOR=1` to disable them.
- `--check-out-of-range` probes rejection of an invalid amount after the normal callback. Off by default: a broken server may generate an extra unpaid invoice.
- Exit codes: **0** no failures (warnings and skips allowed), **1** one or more validation failures, **2** invalid CLI usage.

## Library API

```ts
import { validate, type ValidationResult } from 'lnurl-doctor';

const result: ValidationResult = await validate('hello@getalby.com', {
  amountSats: 10,
  timeoutMs: 5000,
  checkOutOfRange: false,
});

for (const { id, status, message, hint } of result.checks) {
  console.log(id, status, message, hint ?? '');
}
```

`validate(input, options?)` returns the original `input`, resolved `endpoint`
(when valid), `amountMsat` (when requested), `ok` and `checks`.
Each check has an `id`, `status` (`pass`, `warn`, `fail`, or `skip`),
`message`, and a corrective `hint` on failures. CLI JSON uses this same shape.
Pass `options.fetch` to supply a different fetch implementation, for example one
configured to reach Tor. The CLI does not configure Tor itself.

## Checks

| Stage | What is checked |
| --- | --- |
| Input | HTTPS well-known path for a Lightning address, HTTP for onion; bech32 checksum/UTF-8 or scheme decoding. [LUD-01], [LUD-16], [LUD-17] |
| Metadata | HTTP status and response-header timing, redirects, JSON content type/body and LNURL error responses. |
| CORS | The metadata and callback GET must include `Access-Control-Allow-Origin`. A non-matching origin and an unsuccessful metadata OPTIONS probe are warnings; simple GETs do not require preflight. |
| Pay fields | `payRequest`, absolute callback, positive integer msat bounds, correctly encoded metadata with `text/plain`, and a matching `text/identifier` or `text/email` when supplied. Missing address identifiers and a minimum below one sat are interoperability warnings. [LUD-06], [LUD-16] |
| Extensions | Reports `commentAllowed`, `payerData`, and advertised zap support (the two [NIP-57] fields, including the 32-byte hex key format). No payer identity or signed zap request is sent. The callback is skipped when payer data is mandatory. [LUD-12], [LUD-18] |
| Callback | Requests an in-range invoice; checks HTTP, CORS, JSON, LNURL errors and the `pr` string. An optional rejection probe checks the advertised amount range. [LUD-06] |
| Invoice | Decodes [BOLT11], checks Bitcoin mainnet, exact msat amount, expiry, and SHA-256 of the **original** metadata string against the invoice's description hash. It does not verify the invoice signature or payment routability. |
| Verification | If the callback supplies a `verify` URL, checks the response shape and that it references the same invoice, without attempting payment. [LUD-21] |

This is a local diagnostic tool. It contacts URLs provided in the input and in
remote responses and may create an unpaid invoice. Don't expose it as a public
endpoint that validates untrusted input without restricting network egress
(including redirects, private networks and DNS resolution).

See [real-world results](docs/real-world-results.md) for a dated snapshot.
For development, see [CONTRIBUTING.md](CONTRIBUTING.md).

[LUD-01]: https://github.com/lnurl/luds/blob/luds/01.md
[LUD-06]: https://github.com/lnurl/luds/blob/luds/06.md
[LUD-12]: https://github.com/lnurl/luds/blob/luds/12.md
[LUD-16]: https://github.com/lnurl/luds/blob/luds/16.md
[LUD-17]: https://github.com/lnurl/luds/blob/luds/17.md
[LUD-18]: https://github.com/lnurl/luds/blob/luds/18.md
[LUD-21]: https://github.com/lnurl/luds/blob/luds/21.md
[NIP-57]: https://github.com/nostr-protocol/nips/blob/master/57.md
[BOLT11]: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
