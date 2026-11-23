# Real-world results

**2026-11-23 UTC · LNURL Doctor 0.1.0.** The CLI used the default amount and
5-second per-request timeout, except for the labeled Coinos retry. No invoices
were paid, and no signed zap requests or out-of-range probes were sent. These
are point-in-time results for individual addresses, not provider-wide ratings.

| Public Lightning address | Exit | Requested | BOLT11 amount / description hash | NIP-57 advertised | Notable result |
| --- | ---: | ---: | --- | --- | --- |
| [hello@getalby.com](https://getalby.com/p/hello) | 0 | 1 sat | Pass / pass | Yes | LUD-21 verification returned the same, unsettled invoice. |
| [k00b@stacker.news](https://stacker.news/k00b) | 0 | 2 sats | Pass / pass | Yes | LUD-21 verification returned the same, unsettled invoice. |
| [coinos@coinos.io](https://coinos.io/coinos) | 1 → 0 | 1 sat | Not reached → pass / pass | Yes | The callback timed out at 5 seconds; with `--timeout 15000`, it returned HTTP 200 in about 6.2 seconds. |
| [miljan@primal.net](https://primal.net/miljan) | 1 | 1 sat | Pass / fail | Yes | No matching LNURL metadata hash; no LUD-16 identifier entry, unusable OPTIONS response, and an unexpired but unusual 30-day expiry. |
| [dandynotion861@walletofsatoshi.com](https://www.lacasadesatoshi.xyz/en/donate) | 1 | 1 sat | Pass / fail | Yes | No matching LNURL metadata hash; the invoice was unexpired with a 30-day expiry. |
| [jack@strike.me](https://strike.me/learn/what-is-a-lightning-address/) | 0 | 100 sats | Pass / pass | Yes | The GET checks passed; OPTIONS returned HTTP 204 without a usable preflight response, and the invoice expiry was 59 seconds. |

An LNURL-pay endpoint can produce an invoice for the correct amount and still
fail the description-hash check. Wallets that enforce LUD-06 can reject that
invoice even though it decodes. NIP-57 advertisement is a separate check and
does not establish whether a provider will accept a signed zap request.

Reproduce a row with:

```sh
npx --yes github:piolpro/lnurl-doctor#v0.1.0 hello@getalby.com --json
```
