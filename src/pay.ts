import { httpUrl } from './input.js';
import { isRecord, type AddCheck } from './types.js';

export function checkPay(data: Record<string, unknown>, address: string | undefined, add: AddCheck) {
  const rightTag = data.tag === 'payRequest';
  add('pay.tag', rightTag ? 'pass' : 'fail', rightTag ? 'The endpoint advertises payRequest.' :
    'The endpoint does not advertise payRequest.', rightTag ? undefined : 'Return tag: "payRequest" for LNURL-pay.');

  let callback: URL | undefined;
  try {
    callback = httpUrl(data.callback);
    const secure = callback.protocol === 'https:' || callback.hostname.endsWith('.onion');
    add('pay.callback', secure ? 'pass' : 'warn', secure ? 'The callback URL is valid.' :
      'The callback uses unencrypted HTTP on the clearnet.', secure ? undefined : 'Use an HTTPS callback URL.');
  } catch {
    add('pay.callback', 'fail', 'The callback is not an absolute HTTP(S) URL without credentials or a fragment.',
      'Return an absolute HTTPS URL (HTTP is permitted for an onion service).');
  }

  const { minSendable: min, maxSendable: max } = data;
  let range: { min: number; max: number } | undefined;
  if (!isPositiveInteger(min) || !isPositiveInteger(max) || min > max) {
    add('pay.range', 'fail', 'minSendable and maxSendable must be positive safe integers in millisatoshis, with min ≤ max.',
      'Return a valid range in millisatoshis (1 sat = 1000 msat).');
  } else {
    range = { min, max };
    add('pay.range', 'pass', `The sendable range is ${min}–${max} msat.`);
    if (min < 1000) add('pay.minimum', 'warn', 'The minimum is less than 1 sat.',
      'Use a minimum of 1000 msat or more for compatibility with whole-satoshi wallets.');
  }

  const metadata = typeof data.metadata === 'string' ? data.metadata : undefined;
  let entries: unknown;
  try {
    if (metadata !== undefined) entries = JSON.parse(metadata);
  } catch {
    // Report invalid metadata below.
  }
  if (!Array.isArray(entries) || !entries.every(entry =>
    Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === 'string')) ||
    !entries.some(([type]) => type === 'text/plain')) {
    add('pay.metadata', 'fail', 'Metadata must be a JSON-encoded array of [type, value] strings that includes text/plain.',
      'Return metadata as a string, not as a nested JSON array, and add a text/plain entry.');
    if (address) add('pay.identifier', 'skip', 'Cannot check the Lightning address identifier without valid metadata.');
  } else {
    add('pay.metadata', 'pass', 'The metadata string contains a text/plain entry.');
    if (!address) {
      add('pay.identifier', 'skip', 'No Lightning address was supplied for identifier comparison.');
    } else {
      const identifiers = entries.filter(([type]) => type === 'text/email' || type === 'text/identifier');
      if (!identifiers.length) {
        add('pay.identifier', 'warn', 'The Lightning address metadata has no text/identifier or text/email entry.',
          `Add the LUD-16 identifier ${address} to metadata.`);
      } else {
        const matches = identifiers.every(([, value]) => value.toLowerCase() === address.toLowerCase());
        add('pay.identifier', matches ? 'pass' : 'fail', matches ? 'The metadata identifier matches the Lightning address.' :
          'At least one metadata identifier does not match the supplied Lightning address.',
        matches ? undefined : `Use ${address} for the LUD-16 metadata identifier.`);
      }
    }
  }

  if (data.commentAllowed === undefined) {
    add('pay.comment', 'skip', 'The endpoint does not advertise LUD-12 comments.');
  } else if (data.commentAllowed === 0 || isPositiveInteger(data.commentAllowed)) {
    add('pay.comment', 'pass', `LUD-12 comment limit: ${data.commentAllowed} characters.`);
  } else {
    add('pay.comment', 'warn', 'commentAllowed is not a non-negative integer.', 'Return a non-negative character count.');
  }

  let requiresPayerData = false;
  if (data.payerData === undefined) {
    add('pay.payerData', 'skip', 'The endpoint does not advertise LUD-18 payer data.');
  } else if (!isRecord(data.payerData) || !Object.values(data.payerData).every(
    field => isRecord(field) && typeof field.mandatory === 'boolean',
  )) {
    add('pay.payerData', 'warn', 'payerData does not contain valid payer-field definitions.',
      'Declare each requested field with a boolean mandatory property.');
  } else {
    requiresPayerData = Object.values(data.payerData).some(field => isRecord(field) && field.mandatory === true);
    const keys = Object.keys(data.payerData).filter(key => /^[a-z]+$/i.test(key));
    add('pay.payerData', requiresPayerData ? 'warn' : 'pass',
      `LUD-18 payer data is advertised${keys.length ? ` (${keys.join(', ')})` : ''}.${requiresPayerData ? ' Some fields are required.' : ''}`,
      requiresPayerData ? 'Test the callback with a wallet that supplies the mandatory payer data.' : undefined);
  }

  if (data.allowsNostr === true) {
    const valid = typeof data.nostrPubkey === 'string' && /^[0-9a-f]{64}$/i.test(data.nostrPubkey);
    add('nostr.zaps', valid ? 'pass' : 'fail', valid ? 'The endpoint advertises NIP-57 zaps and a 32-byte hex public key.' :
      'allowsNostr is true but nostrPubkey is missing or is not 32-byte hex.',
    valid ? undefined : 'Return the x-only public key of the zap receipt signer as 64 hexadecimal digits.');
  } else if (data.allowsNostr !== undefined && data.allowsNostr !== false) {
    add('nostr.zaps', 'warn', 'allowsNostr is not a boolean.', 'Use the JSON boolean true to advertise NIP-57 zaps.');
  } else {
    add('nostr.zaps', 'skip', 'The endpoint does not advertise NIP-57 zaps.');
  }

  return { rightTag, callback, range, metadata, requiresPayerData };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
