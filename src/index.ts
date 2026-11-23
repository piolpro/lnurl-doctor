import { errorMessage, getJson, preflight, readJson, request, serverReason } from './http.js';
import { httpUrl, resolveInput } from './input.js';
import { checkInvoice } from './invoice.js';
import { checkPay } from './pay.js';
import type { AddCheck, ValidationOptions, ValidationResult } from './types.js';

export type { Check, CheckStatus, ValidationOptions, ValidationResult } from './types.js';

export function amountInMsat(sats: number): number | undefined {
  const rounded = Math.round(sats * 1000);
  return Number.isSafeInteger(rounded) && rounded > 0 && rounded / 1000 === sats ? rounded : undefined;
}

export async function validate(input: string, options: ValidationOptions = {}): Promise<ValidationResult> {
  const result: ValidationResult = { input, ok: true, checks: [] };
  const add: AddCheck = (id, status, message, hint) => {
    result.checks.push({ id, status, message, ...(hint === undefined ? {} : { hint }) });
    if (status === 'fail') result.ok = false;
  };

  let target: ReturnType<typeof resolveInput>;
  try {
    target = resolveInput(input);
  } catch (error) {
    add('input', 'fail', errorMessage(error), 'Supply a Lightning address, a bech32 LNURL, or an lnurlp:// URL.');
    return result;
  }
  result.endpoint = target.url.href;
  add('input', 'pass', 'The input resolved to an LNURL-pay endpoint.');
  if (target.url.protocol === 'http:' && !target.url.hostname.endsWith('.onion')) {
    add('input.transport', 'warn', 'The LNURL points to unencrypted HTTP on the clearnet.', 'Publish an HTTPS LNURL.');
  }
  const amount = options.amountSats === undefined ? undefined : amountInMsat(options.amountSats);
  if (options.amountSats !== undefined && amount === undefined) {
    add('options.amount', 'fail', 'Amount must be positive and exactly representable as a safe integer in msat.',
      'Supply a positive number of sats with up to three decimals.');
    return result;
  }
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647) {
    add('options.timeout', 'fail', 'Timeout must be an integer between 1 and 2147483647 ms.',
      'Supply a timeout in milliseconds, such as 5000.');
    return result;
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  const metadataResponse = await getJson(fetcher, target.url, timeout, 'metadata', add);
  if (!metadataResponse) {
    add('callback', 'skip', 'No usable metadata response; cannot request an invoice.');
    return result;
  }
  await preflight(fetcher, metadataResponse.url, timeout, add);

  const pay = checkPay(metadataResponse.data, target.address, add);
  if (!pay.rightTag || !pay.callback || !pay.range || pay.requiresPayerData) {
    add('callback', 'skip', pay.requiresPayerData ? 'This probe does not supply mandatory payer identity data.' :
      'No usable LNURL-pay callback and range; cannot request an invoice.');
    return result;
  }
  const { min, max } = pay.range;
  const amountMsat = amount ?? Math.ceil(min / 1000) * 1000;
  if (amountMsat < min || amountMsat > max) {
    add('callback.amount', 'fail', amount === undefined ? 'There is no whole-sat amount in the advertised range.' :
      `The requested ${amountMsat} msat is outside the advertised range.`,
    `Pick an amount from ${min} to ${max} msat (the amount option takes sats and supports three decimals).`);
    add('callback', 'skip', 'No invoice was requested with an out-of-range amount.');
    return result;
  }
  result.amountMsat = amountMsat;
  add('callback.amount', 'pass', `Requesting ${amountMsat} msat within the advertised range.`);
  const invoiceUrl = new URL(pay.callback);
  invoiceUrl.searchParams.set('amount', String(amountMsat));
  const invoiceResponse = await getJson(fetcher, invoiceUrl, timeout, 'callback', add);
  if (invoiceResponse) {
    const { pr, routes, verify } = invoiceResponse.data;
    if (routes !== undefined && !Array.isArray(routes)) {
      add('callback.routes', 'warn', 'The optional routes field is not an array.', 'Omit routes or return an array.');
    }
    if (typeof pr !== 'string' || !pr.trim()) {
      add('callback.pr', 'fail', 'The callback did not return a non-empty pr string.', 'Return a BOLT11 invoice in pr.');
    } else {
      add('callback.pr', 'pass', 'The callback returned a pr string.');
      checkInvoice(pr, amountMsat, pay.metadata, add);
      await checkVerify(fetcher, verify, pr, timeout, add);
    }
  }
  if (options.checkOutOfRange) await checkOutOfRange(fetcher, invoiceUrl, max, min, timeout, add);
  return result;
}

async function checkVerify(fetcher: typeof fetch, value: unknown, invoice: string, timeout: number, add: AddCheck) {
  if (value === undefined) {
    add('verify', 'skip', 'The callback does not advertise a LUD-21 verify URL.');
    return;
  }
  const signal = AbortSignal.timeout(timeout);
  try {
    const url = httpUrl(value);
    if (url.protocol !== 'https:' && !url.hostname.endsWith('.onion')) throw new Error('The verify URL must use HTTPS off Tor.');
    const { response } = await request(fetcher, url, 'GET', signal);
    const data = await readJson(response);
    if (data.status === 'ERROR') throw new Error(`The verify endpoint returned ERROR: ${serverReason(data)}`);
    if (!response.ok) throw new Error(`The verify endpoint returned HTTP ${response.status}.`);
    const validState = data.settled === true ? typeof data.preimage === 'string' && /^[0-9a-f]{64}$/i.test(data.preimage) :
      data.settled === false && data.preimage === null;
    if (data.status !== 'OK' || data.pr !== invoice || !validState) {
      throw new Error('The verify response has an invalid status, invoice, settled flag, or preimage.');
    }
    add('verify', 'pass', `The LUD-21 response describes the same invoice (settled: ${data.settled}).`);
  } catch (error) {
    add('verify', 'fail', errorMessage(error, signal), 'Return the LUD-21 status, settled, preimage, and pr fields.');
  }
}

async function checkOutOfRange(
  fetcher: typeof fetch, callback: URL, max: number, min: number, timeout: number, add: AddCheck,
) {
  const signal = AbortSignal.timeout(timeout);
  try {
    const url = new URL(callback);
    const invalid = max < Number.MAX_SAFE_INTEGER ? max + 1 : min - 1;
    url.searchParams.set('amount', String(invalid));
    const { response } = await request(fetcher, url, 'GET', signal);
    const data = await readJson(response);
    if (data.status === 'ERROR' && typeof data.pr !== 'string') {
      add('callback.outOfRange', 'pass', `The server rejected the out-of-range amount (${invalid} msat).`);
      return;
    }
    add('callback.outOfRange', 'warn', 'The response to an out-of-range amount was not an LNURL error.',
      'Reject amounts outside the advertised range with status: "ERROR" and a reason.');
  } catch (error) {
    add('callback.outOfRange', 'warn', `Could not verify out-of-range rejection: ${errorMessage(error, signal)}`,
      'Return an LNURL error object for out-of-range amounts.');
  }
}
