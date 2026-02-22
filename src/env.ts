import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');

    // Security: Check file permissions (warn if world-readable)
    const stat = fs.statSync(envFile);
    const mode = stat.mode & 0o777;
    if (mode & 0o004) {
      console.warn(
        `⚠️  WARNING: .env file is world-readable (mode ${mode.toString(8)}). Run: chmod 600 .env`
      );
    }
  } catch (err) {
    // Log missing .env file for debugging (but don't fail)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.debug('.env file not found, using environment variables only');
    } else {
      console.warn('Error reading .env file:', err);
    }
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Handle escape sequences in double-quoted strings
    if (trimmed.slice(eqIdx + 1).trim().startsWith('"')) {
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }

    // Security: validate value doesn't contain null bytes
    if (value.includes('\0')) {
      console.warn(`Invalid value for ${key}: contains null bytes, skipping`);
      continue;
    }

    if (value) result[key] = value;
  }

  return result;
}

/**
 * Get home directory safely (cross-platform)
 */
export function getHomeDir(): string {
  return process.env.HOME || os.homedir() || '/tmp';
}

/**
 * Validate that required environment variables are set
 */
export function validateRequiredEnv(keys: string[]): { valid: boolean; missing: string[] } {
  const envFileValues = readEnvFile(keys);
  const missing: string[] = [];

  for (const key of keys) {
    if (!process.env[key] && !envFileValues[key]) {
      missing.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}
