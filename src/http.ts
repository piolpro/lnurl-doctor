import { httpUrl } from './input.js';
import { isRecord, type AddCheck } from './types.js';

const origin = 'https://example.com';
const maxResponseBytes = 1024 * 1024;
const redirects = new Set([301, 302, 303, 307, 308]);

interface HttpResult {
  response: Response;
  url: URL;
  hops: number;
}

export function elapsed(start: number): string {
  return `${Math.round(performance.now() - start)} ms`;
}

export async function request(
  fetcher: typeof fetch, url: URL, method: 'GET' | 'OPTIONS', signal: AbortSignal,
): Promise<HttpResult> {
  const headers: Record<string, string> = { Origin: origin, Accept: 'application/json' };
  if (method === 'OPTIONS') headers['Access-Control-Request-Method'] = 'GET';

  for (let hops = 0; ; hops++) {
    const response = await fetcher(url, { method, headers, signal, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!redirects.has(response.status) || !location || method === 'OPTIONS') {
      return { response, url, hops };
    }
    void response.body?.cancel().catch(() => undefined);
    if (hops === 5) throw new Error('More than five HTTP redirects.');
    const next = httpUrl(new URL(location, url).href);
    if (url.protocol === 'https:' && next.protocol !== 'https:') {
      throw new Error('An HTTPS endpoint redirected to insecure HTTP.');
    }
    url = next;
  }
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('The response body is empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error('The response exceeds 1 MiB.');
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body + decoder.decode());
  } catch {
    throw new Error('The response body is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('The JSON response must be an object.');
  return parsed;
}

function corsStatus(response: Response): 'pass' | 'warn' | 'fail' {
  const allowed = response.headers.get('access-control-allow-origin');
  if (allowed === '*' || allowed === origin) return 'pass';
  return allowed ? 'warn' : 'fail';
}

function checkCors(response: Response, id: string, add: AddCheck) {
  const status = corsStatus(response);
  if (status === 'pass') {
    add(id, 'pass', 'Access-Control-Allow-Origin permits the probe origin.');
  } else {
    add(id, status, status === 'fail' ? 'Access-Control-Allow-Origin is missing.' :
      'Access-Control-Allow-Origin is present but does not permit the probe origin.',
    'Allow wallet origins or return Access-Control-Allow-Origin: * for public non-credentialed requests.');
  }
}

export function errorMessage(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'The request timed out.';
  if (error instanceof Error && error.cause instanceof Error) return `${error.message}: ${error.cause.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function serverReason(data: Record<string, unknown>): string {
  return typeof data.reason === 'string' && data.reason.trim()
    ? data.reason.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 240)
    : 'No reason was provided.';
}

export async function getJson(fetcher: typeof fetch, url: URL, timeout: number, id: string, add: AddCheck) {
  const signal = AbortSignal.timeout(timeout);
  const start = performance.now();
  let result: HttpResult;
  try {
    result = await request(fetcher, url, 'GET', signal);
    if (result.hops) add(`${id}.redirects`, 'warn', `Followed ${result.hops} HTTP redirect(s).`,
      'Use the final endpoint directly when possible; browser wallets also need CORS on redirects.');
  } catch (error) {
    add(`${id}.http`, 'fail', `${errorMessage(error, signal)} (${elapsed(start)})`,
      'Check reachability, TLS, redirects and the request timeout. Onion hosts require a Tor-capable fetch.');
    return;
  }

  const { response } = result;
  add(`${id}.http`, response.ok ? 'pass' : 'fail', `HTTP ${response.status} in ${elapsed(start)} (response headers).`,
    response.ok ? undefined : 'Check that the endpoint is public and responds with HTTP 2xx.');
  checkCors(response, `${id}.cors`, add);
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const isJson = mime === 'application/json' || /^application\/[\w.+-]+\+json$/.test(mime ?? '');
  add(`${id}.contentType`, isJson ? 'pass' : 'fail', isJson ? 'Content-Type declares JSON.' :
    'Content-Type does not declare JSON.', isJson ? undefined : 'Return Content-Type: application/json.');
  let data: Record<string, unknown>;
  try {
    data = await readJson(response);
  } catch (error) {
    add(`${id}.json`, 'fail', errorMessage(error, signal), 'Return a UTF-8 JSON object.');
    return;
  }
  add(`${id}.json`, 'pass', 'The response is a valid JSON object.');
  if (data.status === 'ERROR') {
    add(`${id}.status`, 'fail', `The service returned status ERROR: ${serverReason(data)}`,
      'Resolve the service error and retry.');
    return;
  }
  if (!response.ok) return;
  return { data, url: result.url };
}

export async function preflight(fetcher: typeof fetch, url: URL, timeout: number, add: AddCheck) {
  const signal = AbortSignal.timeout(timeout);
  try {
    const { response } = await request(fetcher, url, 'OPTIONS', signal);
    void response.body?.cancel().catch(() => undefined);
    const methods = response.headers.get('access-control-allow-methods')?.split(',').map(value => value.trim());
    if (response.ok && corsStatus(response) === 'pass' && methods?.some(method => method === 'GET' || method === '*')) {
      add('metadata.preflight', 'pass', 'OPTIONS permits GET from the probe origin.');
      return;
    }
    add('metadata.preflight', 'warn', `OPTIONS returned HTTP ${response.status} without a usable preflight response.`,
      'If your clients preflight, allow GET and the wallet origin. Simple GET does not require OPTIONS.');
  } catch (error) {
    add('metadata.preflight', 'warn', errorMessage(error, signal), 'If your clients preflight, support OPTIONS.');
  }
}
