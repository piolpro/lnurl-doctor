export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface ValidationOptions {
  /** Amount in sats; up to three decimal places (one millisatoshi). */
  amountSats?: number;
  /** Timeout in milliseconds per request chain, including reading its response. */
  timeoutMs?: number;
  /** Opt-in invalid amount probe; can generate another invoice on a broken server. */
  checkOutOfRange?: boolean;
  /** Inject a fetch implementation (for example, to route .onion requests). */
  fetch?: typeof globalThis.fetch;
}

export interface ValidationResult {
  input: string;
  endpoint?: string;
  amountMsat?: number;
  ok: boolean;
  checks: Check[];
}

export type AddCheck = (id: string, status: CheckStatus, message: string, hint?: string) => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
