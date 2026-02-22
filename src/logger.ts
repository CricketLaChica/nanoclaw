import fs from 'fs';
import path from 'path';
import pino from 'pino';

import { DATA_DIR, TIMEZONE } from './config.js';

// Ensure logs directory exists
const logsDir = path.join(DATA_DIR, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Get current date in configured timezone (YYYY-MM-DD format)
 * Used for log file naming
 */
function getLocalDateString(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

// Log file path with date-based rotation (uses local timezone)
const getLogFilePath = (): string => {
  const date = getLocalDateString();
  return path.join(logsDir, `nanoclaw-${date}.log`);
};

// Cleanup old log files (keep last 7 days)
const cleanupOldLogs = (): void => {
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('nanoclaw-') && f.endsWith('.log'))
      .sort()
      .reverse();

    // Keep only the last 7 log files
    const toDelete = files.slice(7);
    for (const file of toDelete) {
      const filePath = path.join(logsDir, file);
      fs.unlinkSync(filePath);
    }

    if (toDelete.length > 0) {
      console.log(`Cleaned up ${toDelete.length} old log file(s)`);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
};

// Run cleanup on startup
cleanupOldLogs();

// Daily cleanup timer
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

// Multi-transport logger: pretty console + file
const isDevelopment = process.env.NODE_ENV !== 'production';

// File destination for structured logging
const fileDestination = pino.destination(getLogFilePath());

// Create multi-stream logger
const streams: pino.StreamEntry[] = [
  // Console output (pretty in dev, JSON in prod)
  {
    level: (process.env.LOG_LEVEL || 'info') as pino.Level,
    stream: isDevelopment
      ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
      : process.stdout,
  },
  // File output (always JSON)
  {
    level: 'debug' as pino.Level, // Log everything to file
    stream: fileDestination,
  },
];

export const logger = pino({}, pino.multistream(streams));

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
