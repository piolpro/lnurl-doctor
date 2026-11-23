import { createHash } from 'node:crypto';
import { decode } from 'light-bolt11-decoder';
import type { AddCheck } from './types.js';

export function checkInvoice(invoice: string, amountMsat: number, metadata: string | undefined, add: AddCheck) {
  let sections: { name: string; value?: unknown }[];
  try {
    ({ sections } = decode(invoice));
    const signature = sections.find(section => section.name === 'signature')?.value;
    if (typeof signature !== 'string' || !/^[a-f0-9]{130}$/i.test(signature)) throw new Error('Invalid signature length.');
    const paymentHash = sections.find(section => section.name === 'payment_hash')?.value;
    if (typeof paymentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(paymentHash)) throw new Error('Invalid payment hash.');
  } catch {
    add('invoice.decode', 'fail', 'The callback did not return a decodable BOLT11 invoice.',
      'Generate a valid BOLT11 invoice with a payment hash.');
    return;
  }
  add('invoice.decode', 'pass', 'The invoice decoded as BOLT11 (signature not verified).');
  const field = (name: string) => sections.find(section => section.name === name)?.value;
  const network = sections.find(section => section.name === 'coin_network')?.value;
  const mainnet = typeof network === 'object' && network !== null && 'bech32' in network && network.bech32 === 'bc';
  add('invoice.network', mainnet ? 'pass' : 'fail', mainnet ? 'The invoice is Bitcoin mainnet (lnbc).' :
    'The invoice is not Bitcoin mainnet (lnbc).', mainnet ? undefined : 'Use a mainnet Lightning node for public payments.');

  const amount = field('amount');
  const sameAmount = amount === String(amountMsat);
  add('invoice.amount', sameAmount ? 'pass' : 'fail', sameAmount ? `Invoice amount matches ${amountMsat} msat.` :
    `The invoice amount (${typeof amount === 'string' ? `${amount} msat` : 'unspecified'}) does not match ${amountMsat} msat.`,
  sameAmount ? undefined : 'Generate an invoice for exactly the callback’s amount in millisatoshis.');

  if (metadata === undefined) {
    add('invoice.descriptionHash', 'skip', 'No metadata string is available to verify the description hash.');
  } else {
    const expectedHash = createHash('sha256').update(metadata, 'utf8').digest('hex');
    const hashes = sections.filter(section => section.name === 'description_hash');
    const matches = hashes.length === 1 && hashes[0].value === expectedHash && field('description') === undefined;
    add('invoice.descriptionHash', matches ? 'pass' : 'fail', matches ? 'Description hash matches the original metadata string.' :
      'The invoice has no matching description-hash tag or also contains a plain description.',
    matches ? undefined : 'Set the BOLT11 h tag to SHA-256 of the exact metadata string (UTF-8); do not reserialize it.');
  }

  const now = Math.floor(Date.now() / 1000);
  const timestamp = field('timestamp');
  const expiry = field('expiry') ?? 3600;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) ||
      typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry <= 0 ||
      !Number.isSafeInteger(timestamp + expiry)) {
    add('invoice.expiry', 'fail', 'The invoice has an invalid timestamp or expiry.',
      'Use a positive expiry duration and a valid Unix timestamp.');
  } else if (timestamp + expiry <= now) {
    add('invoice.expiry', 'fail', 'The invoice has already expired.', 'Generate a fresh invoice and check the node clock.');
  } else if (timestamp > now + 300 || expiry < 60 || expiry > 604800) {
    add('invoice.expiry', 'warn', `Invoice timestamp or the ${expiry}-second expiry is unusual.`,
      'Check the node clock and use an expiry from one minute to one week for typical payments.');
  } else {
    add('invoice.expiry', 'pass', `The invoice is unexpired (expires in ${timestamp + expiry - now} seconds).`);
  }
}
