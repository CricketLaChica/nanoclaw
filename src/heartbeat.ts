import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  HEARTBEAT_ACTIVE_HOURS_END,
  HEARTBEAT_ACTIVE_HOURS_START,
  HEARTBEAT_ENABLED,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MODEL,
  TIMEZONE,
} from './config.js';
import { runContainerAgent } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const HEARTBEAT_FILE = path.join(DATA_DIR, 'workspace', 'HEARTBEAT.md');
const HEARTBEAT_LOG_FILE = path.join(GROUPS_DIR, 'main', 'heartbeat-log.md');

// Alert cooldown: suppress re-alerting the same issue within this window
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface HeartbeatDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  onProcess: (
    groupJid: string,
    proc: any,
    containerName: string,
    groupFolder: string,
  ) => void;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// In-flight guard — prevents concurrent heartbeat runs
let heartbeatRunning = false;

/**
 * Read the last N lines of the heartbeat log for context injection.
 */
function readRecentHeartbeatLog(lines = 15): string {
  try {
    if (!fs.existsSync(HEARTBEAT_LOG_FILE)) return '(no prior log entries)';
    const content = fs.readFileSync(HEARTBEAT_LOG_FILE, 'utf-8');
    const all = content.trim().split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(could not read log)';
  }
}

/**
 * Check if we recently sent an alert (within cooldown window) by scanning log.
 * Returns true if an ALERT was logged within the cooldown period.
 */
function recentAlertExists(): boolean {
  try {
    if (!fs.existsSync(HEARTBEAT_LOG_FILE)) return false;
    const content = fs.readFileSync(HEARTBEAT_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').reverse();
    const cutoff = Date.now() - ALERT_COOLDOWN_MS;
    for (const line of lines) {
      // Lines are formatted: [YYYY-MM-DD HH:MM TZ] — ALERT: ...
      const match = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \w+\]/);
      if (!match) continue;
      // Parse date portion only (timezone abbreviation is unreliable for Date parsing).
      // Interpret in configured timezone via Intl comparison — close enough for cooldown.
      const ts = new Date(match[1]).getTime();
      if (isNaN(ts)) continue; // Skip lines with unparseable timestamps
      if (ts < cutoff) break; // older than cutoff, stop scanning
      if (line.includes('ALERT')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if current time is within active hours.
 * Active hours are defined in the TIMEZONE timezone.
 */
function isInActiveHours(): boolean {
  const now = new Date();

  // Get current time in the configured timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const timeStr = formatter.format(now);
  const [hours, minutes] = timeStr.split(':').map(Number);
  const currentTime = hours * 60 + minutes;

  // Parse active hours
  const [startHours, startMinutes] =
    HEARTBEAT_ACTIVE_HOURS_START.split(':').map(Number);
  const [endHours, endMinutes] =
    HEARTBEAT_ACTIVE_HOURS_END.split(':').map(Number);

  const startTime = startHours * 60 + startMinutes;
  const endTime = endHours * 60 + endMinutes;

  return currentTime >= startTime && currentTime <= endTime;
}

/**
 * Read the heartbeat checks file.
 */
function readHeartbeatFile(): string | null {
  try {
    if (!fs.existsSync(HEARTBEAT_FILE)) {
      logger.warn({ path: HEARTBEAT_FILE }, 'HEARTBEAT.md not found');
      return null;
    }
    return fs.readFileSync(HEARTBEAT_FILE, 'utf-8');
  } catch (err) {
    logger.error({ err, path: HEARTBEAT_FILE }, 'Failed to read HEARTBEAT.md');
    return null;
  }
}

/**
 * Run a single heartbeat check.
 * Spawns a lightweight agent to evaluate the heartbeat checks.
 */
async function runHeartbeatCheck(deps: HeartbeatDeps): Promise<void> {
  if (!HEARTBEAT_ENABLED) {
    logger.debug('Heartbeat disabled, skipping');
    return;
  }

  if (!isInActiveHours()) {
    logger.debug('Outside active hours, skipping heartbeat');
    return;
  }

  // In-flight guard: skip if a heartbeat is already running
  if (heartbeatRunning) {
    logger.warn('Heartbeat already running, skipping this cycle');
    return;
  }

  const heartbeatContent = readHeartbeatFile();
  if (!heartbeatContent) {
    logger.debug('No heartbeat content, skipping');
    return;
  }

  // Find the main group (the one that should receive alerts)
  const groups = deps.registeredGroups();
  let mainGroupJid: string | null = null;
  let mainGroup: RegisteredGroup | null = null;

  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'main') {
      mainGroupJid = jid;
      mainGroup = group;
      break;
    }
  }

  if (!mainGroupJid || !mainGroup) {
    logger.warn('No main group found for heartbeat alerts');
    return;
  }

  heartbeatRunning = true;
  logger.info({ group: mainGroup.name }, 'Running heartbeat check');

  const intervalMinutes = Math.round(HEARTBEAT_INTERVAL_MS / 60000);
  const recentLog = readRecentHeartbeatLog(15);
  const hadRecentAlert = recentAlertExists();

  const prompt = `HEARTBEAT CHECK — ${new Date().toISOString()}

Interval: ${intervalMinutes} minutes (only examine activity from the last ${intervalMinutes} minutes)

## Recent heartbeat log (last 15 entries — use this to avoid repeating alerts):
${recentLog}

## Instructions

1. Read and execute the checks in /workspace/HEARTBEAT.md
2. **Scope:** Only consider events/errors/tasks from the last ${intervalMinutes} minutes. Ignore older history.
3. **Dedup:** If an issue already appears as ALERT in the recent log above, do NOT alert again unless it has worsened or is a new occurrence.
4. **Always** append a one-line status entry to /workspace/groups/main/heartbeat-log.md using this format:
   \`[YYYY-MM-DD HH:MM HST] — STATUS: OK | brief summary\`
   or
   \`[YYYY-MM-DD HH:MM HST] — ALERT: brief description of new issue\`
5. **Response:** Reply with exactly one of:
   - \`HEARTBEAT_OK\` — everything is fine or all issues already reported
   - A short alert message (2-5 lines max) describing only NEW issues requiring attention

${hadRecentAlert ? '⚠️ An alert was already sent within the last 2 hours. Only alert again if there is a NEW or significantly worsened issue.' : ''}

Do NOT write a long report. Do NOT repeat known/suppressed issues. Do NOT send an alert for issues already in the recent log.

---
HEARTBEAT.md content:
${heartbeatContent}`;

  try {
    const output = await runContainerAgent(
      mainGroup,
      {
        prompt,
        sessionId: undefined,
        groupFolder: mainGroup.folder,
        chatJid: `heartbeat-${mainGroup.folder}`,
        isMain: true,
        singleMessage: true,
        timeout: 5 * 60 * 1000, // 5 minute timeout
      },
      (proc, containerName) => {
        deps.onProcess(
          `heartbeat-${mainGroup!.folder}`,
          proc,
          containerName,
          mainGroup!.folder,
        );
      },
      async (result) => {
        if (result.result) {
          const text =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);

          if (text.trim() === 'HEARTBEAT_OK' || text.includes('HEARTBEAT_OK')) {
            logger.info('Heartbeat check passed - all OK');
          } else {
            logger.info(
              { response: text.slice(0, 200) },
              'Heartbeat check found issues',
            );
            const alertMessage = `💓 Heartbeat Alert\n\n${text.trim()}`;
            await deps.sendMessage(mainGroupJid!, alertMessage);
          }
        }
      },
    );

    if (output.status === 'error') {
      logger.error({ error: output.error }, 'Heartbeat check failed');
    }
  } catch (err) {
    logger.error({ err }, 'Heartbeat check error');
  } finally {
    heartbeatRunning = false;
  }
}

/**
 * Start the heartbeat timer.
 */
export function startHeartbeat(deps: HeartbeatDeps): void {
  if (!HEARTBEAT_ENABLED) {
    logger.info('Heartbeat system disabled');
    return;
  }

  logger.info(
    {
      intervalMs: HEARTBEAT_INTERVAL_MS,
      activeHours: `${HEARTBEAT_ACTIVE_HOURS_START}-${HEARTBEAT_ACTIVE_HOURS_END}`,
      timezone: TIMEZONE,
    },
    'Starting heartbeat system',
  );

  // Run first check after 1 minute (give system time to stabilize)
  const initialTimer = setTimeout(() => {
    runHeartbeatCheck(deps).catch((err) => {
      logger.error({ err }, 'Initial heartbeat check failed');
    });
  }, 60000);
  initialTimer.unref();

  // Schedule recurring checks
  heartbeatTimer = setInterval(() => {
    runHeartbeatCheck(deps).catch((err) => {
      logger.error({ err }, 'Heartbeat check failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the heartbeat timer.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    logger.info('Heartbeat system stopped');
  }
}
