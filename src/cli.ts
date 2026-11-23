#!/usr/bin/env node
import { amountInMsat, validate, type CheckStatus, type ValidationOptions, type ValidationResult } from './index.js';

const usage = 'Usage: lnurl-doctor <address|lnurl> [--amount sats] [--json] [--timeout ms] [--check-out-of-range]';
const colors: Record<CheckStatus, number> = { pass: 32, warn: 33, fail: 31, skip: 90 };

function report(result: ValidationResult): string {
  const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  const lines = [`LNURL Doctor: ${safe(result.input)}`];
  if (result.endpoint) lines.push(`Endpoint: ${safe(result.endpoint)}`);
  for (const { id, status, message, hint } of result.checks) {
    let label = status.toUpperCase();
    if (process.stdout.isTTY && process.env.NO_COLOR === undefined) label = `\x1b[${colors[status]}m${label}\x1b[0m`;
    lines.push(`  ${label} ${id}: ${safe(message)}`);
    if (hint) lines.push(`       Hint: ${safe(hint)}`);
  }
  const failures = result.checks.filter(check => check.status === 'fail').length;
  const warnings = result.checks.filter(check => check.status === 'warn').length;
  lines.push(`${failures} failure(s), ${warnings} warning(s)`);
  return lines.join('\n');
}

async function main(args: string[]): Promise<number> {
  let input: string | undefined;
  let json = false;
  const options: ValidationOptions = {};
  const seen = new Set<string>();
  try {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      console.log(usage);
      return 0;
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('-')) {
        if (seen.has(arg)) throw new Error('An option was supplied more than once.');
        seen.add(arg);
        if (arg === '--json') json = true;
        else if (arg === '--check-out-of-range') options.checkOutOfRange = true;
        else if (arg === '--amount') {
          const value = args[++i];
          if (!value || !/^\d+(?:\.\d{1,3})?$/.test(value) || amountInMsat(Number(value)) === undefined) {
            throw new Error('--amount expects a positive number of sats with up to three decimals.');
          }
          options.amountSats = Number(value);
        } else if (arg === '--timeout') {
          const value = args[++i];
          if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2147483647) {
            throw new Error('--timeout expects an integer between 1 and 2147483647 ms.');
          }
          options.timeoutMs = Number(value);
        } else throw new Error('Unknown option.');
      } else {
        if (input !== undefined) throw new Error('Supply only one address or LNURL.');
        input = arg;
      }
    }
    if (!input?.trim()) throw new Error('An address or LNURL is required.');
  } catch (error) {
    console.error(`${(error as Error).message}\n${usage}`);
    return 2;
  }
  const result = await validate(input, options);
  console.log(json ? JSON.stringify(result, null, 2) : report(result));
  return result.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
