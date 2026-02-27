import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'WEBSOCKET_AUTH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
  'HEARTBEAT_ENABLED',
  'HEARTBEAT_INTERVAL_MS',
  'HEARTBEAT_ACTIVE_HOURS_START',
  'HEARTBEAT_ACTIVE_HOURS_END',
  'HEARTBEAT_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Default to Pacific/Honolulu (HST = UTC-10, no DST)
// Set TZ env var to override
export const TIMEZONE = process.env.TZ || 'Pacific/Honolulu';

// Set the process timezone immediately so all Date operations use it
// This affects new Date().toString(), getHours(), etc.
if (process.env.TZ !== TIMEZONE) {
  process.env.TZ = TIMEZONE;
}

// WebSocket server configuration
export const WEBSOCKET_PORT = parseInt(
  process.env.WEBSOCKET_PORT || '8080',
  10,
);
export const WEBSOCKET_CORS_ORIGIN = process.env.WEBSOCKET_CORS_ORIGIN || '*';
export const WEBSOCKET_AUTH_TOKEN =
  process.env.WEBSOCKET_AUTH_TOKEN ||
  envConfig.WEBSOCKET_AUTH_TOKEN ||
  'change-me-in-production';

// Telegram configuration
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';

// Heartbeat configuration
export const HEARTBEAT_ENABLED =
  (process.env.HEARTBEAT_ENABLED || envConfig.HEARTBEAT_ENABLED || 'true') === 'true';
export const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.HEARTBEAT_INTERVAL_MS || '1800000',
  10,
); // 30 minutes default
export const HEARTBEAT_ACTIVE_HOURS_START =
  process.env.HEARTBEAT_ACTIVE_HOURS_START || '08:00';
export const HEARTBEAT_ACTIVE_HOURS_END =
  process.env.HEARTBEAT_ACTIVE_HOURS_END || '22:00';
export const HEARTBEAT_MODEL =
  process.env.HEARTBEAT_MODEL || 'claude-sonnet-4-20250514';

// Security: Warn if using default token in production-like environment
if (WEBSOCKET_AUTH_TOKEN === 'change-me-in-production') {
  console.warn(
    '⚠️  WARNING: Using default WEBSOCKET_AUTH_TOKEN. Set a secure token in .env for production!',
  );
}

// WebSocket message size limit (1MB default)
export const WEBSOCKET_MAX_MESSAGE_SIZE = parseInt(
  process.env.WEBSOCKET_MAX_MESSAGE_SIZE || '1048576',
  10,
);

// WebSocket auth rate limiting
export const WEBSOCKET_AUTH_MAX_ATTEMPTS = parseInt(
  process.env.WEBSOCKET_AUTH_MAX_ATTEMPTS || '5',
  10,
);
export const WEBSOCKET_AUTH_WINDOW_MS = parseInt(
  process.env.WEBSOCKET_AUTH_WINDOW_MS || '60000',
  10,
); // 1 minute

// Container resource limits
export const CONTAINER_MEMORY_LIMIT =
  process.env.CONTAINER_MEMORY_LIMIT || '2g';
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || '1.0';

// Known agents that can be delegated to
export const KNOWN_AGENTS = [
  'maui', 'nalu', 'hoku', 'hali', 'moana', 'koa', 'leilani', 'noelani', 'ikaika',
  'reef', 'pali', 'mana', 'ahi', 'liko', 'kai', 'wai', 'makani', 'lani', 'keoni', 'pua', 'noe'
];

// Main group JID for system notifications (configurable via env)
export const MAIN_GROUP_JID =
  process.env.MAIN_GROUP_JID || '120363422227220717@g.us';

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Validate all configuration values
 * Call this on startup to catch configuration issues early
 */
export function validateConfig(): ConfigValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Validate WebSocket port
  if (isNaN(WEBSOCKET_PORT) || WEBSOCKET_PORT < 1 || WEBSOCKET_PORT > 65535) {
    errors.push(`Invalid WEBSOCKET_PORT: ${WEBSOCKET_PORT}. Must be 1-65535.`);
  } else if (WEBSOCKET_PORT < 1024) {
    warnings.push(
      `WEBSOCKET_PORT ${WEBSOCKET_PORT} is a privileged port. May require elevated permissions.`,
    );
  }

  // Validate WebSocket auth token
  if (WEBSOCKET_AUTH_TOKEN === 'change-me-in-production') {
    warnings.push(
      'Using default WEBSOCKET_AUTH_TOKEN. Set a secure token in production!',
    );
  } else if (WEBSOCKET_AUTH_TOKEN.length < 16) {
    warnings.push(
      'WEBSOCKET_AUTH_TOKEN is shorter than 16 characters. Consider using a longer token.',
    );
  }

  // Validate container timeout
  if (isNaN(CONTAINER_TIMEOUT) || CONTAINER_TIMEOUT < 60000) {
    warnings.push(
      `CONTAINER_TIMEOUT is ${CONTAINER_TIMEOUT}ms. Minimum recommended is 60000ms (1 minute).`,
    );
  } else if (CONTAINER_TIMEOUT > 86400000) {
    warnings.push(
      `CONTAINER_TIMEOUT is ${CONTAINER_TIMEOUT / 3600000}h. Very long timeouts may cause resource issues.`,
    );
  }

  // Validate idle timeout
  if (isNaN(IDLE_TIMEOUT) || IDLE_TIMEOUT < 60000) {
    warnings.push(
      `IDLE_TIMEOUT is ${IDLE_TIMEOUT}ms. Minimum recommended is 60000ms (1 minute).`,
    );
  }

  // Validate concurrent containers
  if (MAX_CONCURRENT_CONTAINERS < 1) {
    errors.push(
      `MAX_CONCURRENT_CONTAINERS must be at least 1. Got: ${MAX_CONCURRENT_CONTAINERS}`,
    );
  } else if (MAX_CONCURRENT_CONTAINERS > 20) {
    warnings.push(
      `MAX_CONCURRENT_CONTAINERS is ${MAX_CONCURRENT_CONTAINERS}. High values may cause resource exhaustion.`,
    );
  }

  // Validate message size
  if (WEBSOCKET_MAX_MESSAGE_SIZE < 1024) {
    warnings.push(
      `WEBSOCKET_MAX_MESSAGE_SIZE is very small (${WEBSOCKET_MAX_MESSAGE_SIZE} bytes). May break functionality.`,
    );
  } else if (WEBSOCKET_MAX_MESSAGE_SIZE > 10485760) {
    // 10MB
    warnings.push(
      `WEBSOCKET_MAX_MESSAGE_SIZE is large (${WEBSOCKET_MAX_MESSAGE_SIZE / 1048576}MB). May cause memory issues.`,
    );
  }

  // Validate auth rate limiting
  if (WEBSOCKET_AUTH_MAX_ATTEMPTS < 1) {
    errors.push(
      `WEBSOCKET_AUTH_MAX_ATTEMPTS must be at least 1. Got: ${WEBSOCKET_AUTH_MAX_ATTEMPTS}`,
    );
  }

  if (WEBSOCKET_AUTH_WINDOW_MS < 1000) {
    warnings.push(
      `WEBSOCKET_AUTH_WINDOW_MS is very short (${WEBSOCKET_AUTH_WINDOW_MS}ms). May cause false rate limit hits.`,
    );
  }

  // Validate memory limit format
  const memoryLimitMatch = CONTAINER_MEMORY_LIMIT.match(/^(\d+)([kmg]?)$/i);
  if (!memoryLimitMatch) {
    warnings.push(
      `CONTAINER_MEMORY_LIMIT "${CONTAINER_MEMORY_LIMIT}" may not be a valid Docker memory format.`,
    );
  }

  // Validate CPU limit
  const cpuLimit = parseFloat(CONTAINER_CPU_LIMIT);
  if (isNaN(cpuLimit) || cpuLimit <= 0) {
    warnings.push(
      `CONTAINER_CPU_LIMIT "${CONTAINER_CPU_LIMIT}" should be a positive number.`,
    );
  } else if (cpuLimit > 4) {
    warnings.push(
      `CONTAINER_CPU_LIMIT is ${cpuLimit}. High CPU limits may not be effective on single-CPU systems.`,
    );
  }

  // Validate timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: TIMEZONE });
  } catch {
    warnings.push(`TIMEZONE "${TIMEZONE}" may not be a valid IANA timezone.`);
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

// Run validation on import (in development) or log warnings
let configValidated = false;

export function ensureConfigValidated(): void {
  if (configValidated) return;
  configValidated = true;

  const result = validateConfig();

  if (result.errors.length > 0) {
    console.error('❌ Configuration Errors:');
    result.errors.forEach((e) => console.error(`   - ${e}`));
  }

  if (result.warnings.length > 0) {
    console.warn('⚠️  Configuration Warnings:');
    result.warnings.forEach((w) => console.warn(`   - ${w}`));
  }

  if (result.valid && result.warnings.length === 0) {
    console.log('✓ Configuration validated successfully');
  }
}
