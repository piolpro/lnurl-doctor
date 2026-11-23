import { bech32 } from 'bech32';

export function httpUrl(value: unknown): URL {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) {
    throw new Error('Expected an absolute HTTP or HTTPS URL without spaces or backslashes.');
  }
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new Error('URLs must not contain credentials or fragments.');
  }
  return url;
}

export function resolveInput(input: string): { url: URL; address?: string } {
  const value = input.trim().replace(/^lightning:/i, '');
  if (/^lnurl1/i.test(value)) {
    const { words, prefix } = bech32.decode(value, 8192);
    if (prefix !== 'lnurl') throw new Error('The bech32 prefix is not lnurl.');
    return { url: httpUrl(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bech32.fromWords(words)))) };
  }
  if (/^lnurlp:\/\//i.test(value)) {
    const url = httpUrl(value.replace(/^lnurlp:/i, 'https:'));
    if (url.hostname.endsWith('.onion')) url.protocol = 'http:';
    return { url };
  }
  const address = /^([a-z0-9._+-]+)@([^@:/?#%\s\\]+)$/i.exec(value);
  if (!address || ['.', '..'].includes(address[1])) throw new Error('Expected user@domain, lnurl1…, or lnurlp://…');
  const [, user, domain] = address;
  const url = httpUrl(`https://${domain}/.well-known/lnurlp/${user}`);
  if (!url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new Error('The Lightning address has an invalid domain.');
  }
  if (url.hostname.endsWith('.onion')) url.protocol = 'http:';
  return { url, address: `${user}@${url.hostname}` };
}
