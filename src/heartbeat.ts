import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
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

  logger.info({ group: mainGroup.name }, 'Running heartbeat check');

  const prompt = `HEARTBEAT CHECK

Read and execute the checks in /workspace/HEARTBEAT.md

Instructions:
1. Read the file at /workspace/HEARTBEAT.md
2. Execute each check listed
3. If everything is OK and nothing needs attention, respond with exactly: HEARTBEAT_OK
4. If something needs attention, respond with details about what needs to be done

Do NOT include any other text if everything is OK. Just "HEARTBEAT_OK".

---
HEARTBEAT.md content for reference:
${heartbeatContent}`;

  try {
    const output = await runContainerAgent(
      mainGroup,
      {
        prompt,
        sessionId: undefined,
        groupFolder: mainGroup.folder,
        chatJid: `heartbeat-${Date.now()}`,
        isMain: true,
        singleMessage: true, // Exit after completing checks
        timeout: 5 * 60 * 1000, // 5 minute timeout (shorter than default 30min)
      },
      (proc, containerName) => {
        deps.onProcess(
          `heartbeat-${Date.now()}`,
          proc,
          containerName,
          mainGroup!.folder,
        );
      },
      async (result) => {
        // Handle streaming results if needed
        if (result.result) {
          const text =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);

          // Check if it's an OK response
          if (text.trim() === 'HEARTBEAT_OK' || text.includes('HEARTBEAT_OK')) {
            logger.info('Heartbeat check passed - all OK');
          } else {
            // Something needs attention - send alert
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
  setTimeout(() => {
    runHeartbeatCheck(deps).catch((err) => {
      logger.error({ err }, 'Initial heartbeat check failed');
    });
  }, 60000);

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
