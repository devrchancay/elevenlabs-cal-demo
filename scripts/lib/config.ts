/**
 * Helpers shared by the scripts. Not part of the server.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Loads `.env` without a dependency. Good enough for local scripts: the server
 * itself reads variables from the environment, not from a file.
 */
export function loadDotEnv(path = resolve(ROOT, '.env')): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Reads a required variable or exits with a useful message. */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`\n[x] Missing variable ${name}${hint ? `.\n  ${hint}` : '.'}\n`);
    process.exit(1);
  }
  return value.trim();
}

const ESC = String.fromCharCode(27);

/** ANSI colors, no dependencies. */
export const colors = {
  ok: (s: string) => `${ESC}[32m${s}${ESC}[0m`,
  warn: (s: string) => `${ESC}[33m${s}${ESC}[0m`,
  err: (s: string) => `${ESC}[31m${s}${ESC}[0m`,
  dim: (s: string) => `${ESC}[2m${s}${ESC}[0m`,
  bold: (s: string) => `${ESC}[1m${s}${ESC}[0m`,
};
