import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { bech32 } from 'bech32';
import { validate } from '../dist/index.js';

const run = promisify(execFile);
const metadata = '[ [ "text/plain", "Test payment" ], [ "text/identifier", "alice@example.test" ] ]';
// Signed description-hash example from BOLT #11's payment encoding specification.
const boltFixture = 'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44';
const fixtureMemo = 'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon';
const lnurl = url => bech32.encode('lnurl', bech32.toWords(Buffer.from(url)), 8192);

function invoice({ amount = 1000, memo = metadata, network = 'bc', expiry, age = 0 } = {}) {
  const words = width => number => Array.from({ length: width }, (_, index) =>
    Math.floor(number / 32 ** (width - index - 1)) % 32);
  const tag = (name, data) => ['qpzry9x8gf2tvdw0s3jn54khce6mua7l'.indexOf(name), ...words(2)(data.length), ...data];
  const timestamp = words(7)(Math.floor(Date.now() / 1000) - age);
  const hash = tag('h', bech32.toWords(createHash('sha256').update(memo).digest()));
  const payHash = tag('p', bech32.toWords(Buffer.alloc(32, 1)));
  const expiration = expiry === undefined ? [] : tag('x', words(4)(expiry));
  // No signature verification is expected for these synthesized field combinations.
  const signature = bech32.decode(boltFixture, 8192).words.slice(-104);
  return bech32.encode(`ln${network}${amount === null ? '' : `${amount * 10}p`}`,
    [...timestamp, ...payHash, ...hash, ...expiration, ...signature], 8192);
}

async function server(t, config = {}) {
  const calls = [];
  let base;
  let pr;
  const node = createServer((req, res) => {
    const url = new URL(req.url, base);
    calls.push({ path: url.pathname, method: req.method, amount: url.searchParams.get('amount'), token: url.searchParams.get('token') });
    if (!(config.noCors ?? []).includes(url.pathname)) res.setHeader('Access-Control-Allow-Origin', config.origin ?? '*');
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': config.contentType ?? 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(config.optionsStatus ?? 204, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
      return res.end();
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/meta' });
      return res.end();
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (url.pathname === '/hang') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.write('{');
    }
    if (url.pathname === '/malformed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{');
    }
    if (url.pathname === '/callback') {
      if (url.searchParams.get('amount') === '10001' && !config.acceptInvalid) {
        return json({ status: 'ERROR', reason: 'amount too large' }, 400);
      }
      pr = config.pr ?? invoice({ amount: Number(url.searchParams.get('amount')), ...config.invoice });
      return json(config.callbackResponse ?? { pr, ...(config.verify ? { verify: 'https://example.test/verify' } : {}) });
    }
    if (url.pathname === '/verify') return json(config.verifyResponse ?? { status: 'OK', settled: false, preimage: null, pr });
    return json(config.metadataResponse ?? {
      callback: `${base}/callback?token=abc`, tag: 'payRequest', minSendable: 1000, maxSendable: 10000,
      metadata, ...config.pay,
    }, config.status);
  });
  await new Promise(resolve => node.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${node.address().port}`;
  t.after(() => {
    node.closeAllConnections();
    return new Promise((resolve, reject) => node.close(error => error ? reject(error) : resolve()));
  });
  const fetchLocal = (value, init) => {
    const url = new URL(value);
    return fetch(url.hostname === '127.0.0.1' ? url : new URL(url.pathname + url.search, base), init);
  };
  return { base, calls, fetchLocal };
}

function statuses(result, checks) {
  const actual = Object.fromEntries(result.checks.map(({ id, status }) => [id, status]));
  for (const [id, status] of Object.entries(checks)) assert.equal(actual[id], status, id);
  assert.equal(result.ok, !result.checks.some(check => check.status === 'fail'));
  for (const check of result.checks.filter(check => check.status === 'fail')) assert.ok(check.hint, check.id);
}

test('valid address follows LUD-16, preserves callback arguments, checks raw hash and extensions', async t => {
  const { calls, fetchLocal } = await server(t, {
    pay: { minSendable: 1501, commentAllowed: 12, payerData: { name: { mandatory: false } }, allowsNostr: true, nostrPubkey: 'a'.repeat(64) },
    verify: true,
  });
  const result = await validate('lightning:alice@Example.Test', { fetch: fetchLocal, checkOutOfRange: true });
  assert.equal(result.endpoint, 'https://example.test/.well-known/lnurlp/alice');
  assert.equal(result.amountMsat, 2000);
  assert.equal(result.ok, true);
  statuses(result, {
    'metadata.http': 'pass', 'metadata.cors': 'pass', 'metadata.contentType': 'pass', 'metadata.preflight': 'pass',
    'pay.tag': 'pass', 'pay.range': 'pass', 'pay.metadata': 'pass', 'pay.identifier': 'pass', 'pay.comment': 'pass',
    'pay.payerData': 'pass', 'nostr.zaps': 'pass', 'callback.amount': 'pass', 'callback.cors': 'pass', 'callback.pr': 'pass',
    'invoice.decode': 'pass', 'invoice.network': 'pass', 'invoice.amount': 'pass', 'invoice.descriptionHash': 'pass',
    'invoice.expiry': 'pass', 'callback.outOfRange': 'pass', verify: 'pass',
  });
  assert.deepEqual(calls.filter(call => call.path === '/callback').map(({ token, amount }) => [token, amount]),
    [['abc', '2000'], ['abc', '10001']]);
});

test('uppercase bech32 LNURL follows redirects and reports optional fields as skipped', async t => {
  const { base } = await server(t);
  const result = await validate(`LIGHTNING:${lnurl(base + '/redirect').toUpperCase()}`);
  assert.equal(result.ok, true);
  statuses(result, { 'input.transport': 'warn', 'metadata.redirects': 'warn', 'pay.identifier': 'skip',
    'pay.callback': 'warn', 'pay.comment': 'skip', 'pay.payerData': 'skip', 'nostr.zaps': 'skip', verify: 'skip' });
});

test('LUD-17 and Lightning address use HTTP for onion hosts and HTTPS for clearnet', async t => {
  const { fetchLocal } = await server(t);
  const direct = await validate('lnurlp://example.test/meta', { fetch: fetchLocal });
  assert.equal(direct.endpoint, 'https://example.test/meta');
  const onion = await validate('lnurlp://example.onion/meta', { fetch: fetchLocal });
  assert.equal(onion.endpoint, 'http://example.onion/meta');
  const address = await validate('alice@example.onion', { fetch: fetchLocal });
  assert.equal(address.endpoint, 'http://example.onion/.well-known/lnurlp/alice');
});

test('invalid, mixed-case, non-HTTP and traversal inputs do not fetch', async () => {
  for (const input of ['hello', '..@example.test', 'alice@example.test:443', 'lnurl1xyz', 'Ln' + lnurl('https://example.test').slice(2),
    lnurl('file:///etc/passwd'), 'lnurlp://user:password@example.test']) {
    const result = await validate(input, { fetch: () => assert.fail('unexpected fetch') });
    statuses(result, { input: 'fail' });
  }
});

test('invalid options are reported before fetching', async () => {
  for (const options of [{ amountSats: 1.2345 }, { amountSats: 0 }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    const result = await validate('alice@example.test', { ...options, fetch: () => assert.fail('unexpected fetch') });
    statuses(result, { [options.timeoutMs === undefined ? 'options.amount' : 'options.timeout']: 'fail' });
  }
});

test('HTTP and LNURL errors both survive the response diagnostics', async t => {
  const { base } = await server(t, { status: 404, metadataResponse: { status: 'ERROR', reason: 'unknown recipient' } });
  const result = await validate(lnurl(base + '/meta'));
  statuses(result, { 'metadata.http': 'fail', 'metadata.json': 'pass', 'metadata.status': 'fail', callback: 'skip' });
  assert.match(result.checks.find(check => check.id === 'metadata.status').message, /unknown recipient/);
});

test('malformed JSON, body timeout and redirect loops fail independently', async t => {
  const { base } = await server(t);
  statuses(await validate(lnurl(base + '/malformed')), { 'metadata.json': 'fail', callback: 'skip' });
  const timeout = await validate(lnurl(base + '/hang'), { timeoutMs: 150 });
  statuses(timeout, { 'metadata.http': 'pass', 'metadata.json': 'fail', callback: 'skip' });
  assert.match(timeout.checks.find(check => check.id === 'metadata.json').message, /timed out/);
  statuses(await validate(lnurl(base + '/loop')), { 'metadata.http': 'fail', callback: 'skip' });
});

test('CORS, wrong content type and rejected OPTIONS are reported without suppressing a usable invoice', async t => {
  const { base } = await server(t, { noCors: ['/meta', '/callback'], optionsStatus: 405, contentType: 'text/plain' });
  statuses(await validate(lnurl(base + '/meta')), { 'metadata.cors': 'fail', 'metadata.preflight': 'warn',
    'metadata.contentType': 'fail', 'callback.cors': 'fail', 'callback.contentType': 'fail', 'invoice.amount': 'pass' });
});

test('origin restriction is a warning, not a wildcard pass', async t => {
  const { base } = await server(t, { origin: 'https://wallet.example' });
  statuses(await validate(lnurl(base + '/meta')), { 'metadata.cors': 'warn', 'callback.cors': 'warn', 'metadata.preflight': 'warn' });
});

test('malformed payment fields and advertised zap key are diagnosed before the callback', async t => {
  const { calls, fetchLocal } = await server(t, { pay: {
    tag: 'withdrawRequest', callback: 'javascript:alert(1)', minSendable: 2.5, maxSendable: 1, metadata: '[]',
    commentAllowed: -1, payerData: { name: {} }, allowsNostr: true,
  } });
  statuses(await validate('alice@example.test', { fetch: fetchLocal }), { 'pay.tag': 'fail', 'pay.callback': 'fail',
    'pay.range': 'fail', 'pay.metadata': 'fail', 'pay.identifier': 'skip', 'pay.comment': 'warn', 'pay.payerData': 'warn',
    'nostr.zaps': 'fail', callback: 'skip' });
  assert.equal(calls.length, 2);
});

test('mismatched Lightning address and mandatory payer data are explained', async t => {
  const { calls, fetchLocal } = await server(t, { pay: { payerData: { name: { mandatory: true } } } });
  statuses(await validate('bob@example.test', { fetch: fetchLocal }), {
    'pay.identifier': 'fail', 'pay.payerData': 'warn', callback: 'skip',
  });
  assert.equal(calls.length, 2);
});

test('missing identifier is a warning; text/email is supported', async t => {
  const missing = await server(t, { pay: { metadata: '[["text/plain","m"]]' } });
  const email = await server(t, { pay: { metadata: metadata.replace('text/identifier', 'text/email') } });
  statuses(await validate('alice@example.test', { fetch: missing.fetchLocal }), { 'pay.identifier': 'warn' });
  statuses(await validate('alice@example.test', { fetch: email.fetchLocal }), { 'pay.identifier': 'pass' });
});

test('amount outside range does not call the callback and fractional sats work', async t => {
  const { calls, base } = await server(t, { pay: { minSendable: 100, maxSendable: 999 } });
  statuses(await validate(lnurl(base + '/meta')), { 'pay.minimum': 'warn', 'callback.amount': 'fail', callback: 'skip' });
  statuses(await validate(lnurl(base + '/meta'), { amountSats: 1.5 }), { 'callback.amount': 'fail', callback: 'skip' });
  assert.equal(calls.filter(call => call.path === '/callback').length, 0);
  const result = await validate(lnurl(base + '/meta'), { amountSats: 0.501 });
  statuses(result, { 'callback.amount': 'pass', 'invoice.amount': 'pass' });
  assert.equal(result.amountMsat, 501);
});

test('callback service errors, missing pr, and malformed optional routes are diagnosed', async t => {
  const error = await server(t, { callbackResponse: { status: 'ERROR', reason: 'invoice creation failed' } });
  const missing = await server(t, { callbackResponse: { routes: 'not an array' } });
  statuses(await validate(lnurl(error.base + '/meta')), { 'callback.status': 'fail' });
  statuses(await validate(lnurl(missing.base + '/meta')), { 'callback.pr': 'fail', 'callback.routes': 'warn' });
});

test('BOLT11 detects wrong network, amount, reserialized metadata and expiry', async t => {
  const { base } = await server(t, { invoice: {
    amount: 2000, memo: JSON.stringify(JSON.parse(metadata)), network: 'tb', expiry: 3600, age: 4000,
  } });
  statuses(await validate(lnurl(base + '/meta')), { 'invoice.decode': 'pass', 'invoice.network': 'fail',
    'invoice.amount': 'fail', 'invoice.descriptionHash': 'fail', 'invoice.expiry': 'fail' });
});

test('real signed BOLT11 specification fixture decodes and uses the default expiry', async t => {
  const { base } = await server(t, { pr: boltFixture, pay: { metadata: fixtureMemo, minSendable: 2e9, maxSendable: 2e9 } });
  t.mock.method(Date, 'now', () => 1496314659 * 1000);
  statuses(await validate(lnurl(base + '/meta')), { 'invoice.decode': 'pass', 'invoice.network': 'pass',
    'invoice.amount': 'pass', 'invoice.descriptionHash': 'pass', 'invoice.expiry': 'pass', 'pay.metadata': 'fail' });
});

test('bad BOLT11, amountless invoice and odd expiry are distinguishable', async t => {
  const malformed = await server(t, { pr: 'lnbc1malformed' });
  const odd = await server(t, { invoice: { amount: null, expiry: 42 } });
  statuses(await validate(lnurl(malformed.base + '/meta')), { 'invoice.decode': 'fail' });
  statuses(await validate(lnurl(odd.base + '/meta')), { 'invoice.decode': 'pass', 'invoice.amount': 'fail', 'invoice.expiry': 'warn' });
});

test('invalid verification and acceptance of the opt-in negative amount are reported', async t => {
  const { base, fetchLocal } = await server(t, { verify: true, verifyResponse: { status: 'OK', settled: true }, acceptInvalid: true });
  statuses(await validate(lnurl(base + '/meta'), { fetch: fetchLocal, checkOutOfRange: true }),
    { verify: 'fail', 'callback.outOfRange': 'warn' });
});

test('CLI reports human and JSON output and the three exit codes', async t => {
  const { base } = await server(t);
  const cli = (...args) => run(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, NO_COLOR: '1' } });
  const target = lnurl(base + '/meta');
  const human = await cli(target, '--timeout', '5000');
  assert.match(human.stdout, /PASS invoice\.amount/);
  assert.doesNotMatch(human.stdout, /\x1b/);
  const json = await cli(target, '--json', '--amount', '2.5');
  assert.equal(JSON.parse(json.stdout).amountMsat, 2500);
  await assert.rejects(cli('malformed', '--json'), error => error.code === 1 && JSON.parse(error.stdout).ok === false);
  await assert.rejects(cli(target, '--amount', 'bad'), error => error.code === 2 && error.stderr.includes('Usage:'));
  assert.match((await cli('--help')).stdout, /^Usage:/);
});
