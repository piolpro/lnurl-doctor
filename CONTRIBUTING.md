# Contributing

Use Node.js 18.18 or later. From a clean checkout run:

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Run the built CLI with `node dist/cli.js <address|lnurl>`. Add a test with the
local mock HTTP server for protocol behavior changes. Never commit real payer
information, callback secrets, or payment preimages. A useful bug report includes
the failing check ID, input type, and a redacted `--json` report.
