import { ChildProcess, spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { runDailyMemoryTask } from './memory-scheduler.js';
import { getRelevantMemories, readPersonalityFile } from './memory.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Idle timer: writes _close sentinel after IDLE_TIMEOUT of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Scheduled task idle timeout, closing container stdin');
      deps.queue.closeStdin(task.chat_jid);
    }, IDLE_TIMEOUT);
  };

  try {
    // Build prompt with memory injection for scheduled tasks
    let promptWithContext = task.prompt;
    const contextParts: string[] = [];

    // Add personality context if SOUL.md exists
    const soulContent = readPersonalityFile(task.group_folder, 'SOUL.md');
    if (soulContent) {
      contextParts.push(`**Personality & Core Values:**\n${soulContent.trim()}\n`);
    }

    // Add relevant long-term memories
    const relevantMemories = getRelevantMemories(task.group_folder, task.prompt, 5);

    logger.debug(
      { taskId: task.id, groupFolder: task.group_folder, memoryCount: relevantMemories.length },
      'Scheduled task: Memory injection fetched relevant memories'
    );

    if (relevantMemories.length > 0) {
      const memoryText = relevantMemories
        .map(m => `- [${m.memory_type}] ${m.content}`)
        .join('\n');
      contextParts.push(`**Relevant Memories:**\n${memoryText}\n`);
    }

    if (contextParts.length > 0) {
      promptWithContext = `${contextParts.join('\n\n')}\n\n**Task:** ${task.prompt}`;

      logger.debug(
        { taskId: task.id, contextSize: contextParts.length },
        'Scheduled task: Memory injection added context to prompt'
      );
    }

    const output = await runContainerAgent(
      group,
      {
        prompt: promptWithContext,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          // Only reset idle timer on actual results, not session-update markers
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Run a command directly on the HOST (not in container).
 * This is persistent and survives container lifecycle.
 */
async function runHostCommand(
  command: string,
  taskId: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<{ success: boolean; output: string; error: string | null }> {
  const startTime = Date.now();

  logger.info({ taskId, command }, 'Executing host command');

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn('bash', ['-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });

    const durationMs = Date.now() - startTime;
    logger.info({ taskId, durationMs, outputLength: output.length }, 'Host command completed');

    return {
      success: true,
      output,
      error: null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId, error }, 'Host command failed');

    return {
      success: false,
      output: '',
      error,
    };
  }
}

/**
 * Send an IPC message from one agent to another.
 * This enables inter-agent communication and delegation.
 */
function sendAgentMessage(
  fromAgent: string,
  toAgent: string,
  message: string,
  context?: Record<string, unknown>,
): { success: boolean; error?: string } {
  try {
    const targetIpcDir = path.join(DATA_DIR, 'ipc', toAgent, 'input');
    fs.mkdirSync(targetIpcDir, { recursive: true });

    const filename = `agent-${fromAgent}-${Date.now()}.json`;
    const filePath = path.join(targetIpcDir, filename);

    const payload = {
      type: 'agent_message',
      from: fromAgent,
      to: toAgent,
      message,
      context: context || {},
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    logger.info(
      { fromAgent, toAgent, message: message.substring(0, 100) },
      'Agent message sent via IPC'
    );

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ fromAgent, toAgent, error }, 'Failed to send agent message via IPC');

    return { success: false, error };
  }
}

let schedulerRunning = false;
let lastMemoryTaskDate: string | null = null;
let memoryTaskRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      // Check if we need to run the daily memory task
      // Run at 2 AM daily (configurable)
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const currentTime = now.getHours();

      // Run memory task once per day at 2 AM
      if (lastMemoryTaskDate !== today && currentTime >= 2 && !memoryTaskRunning) {
        logger.info({ date: today }, 'Running daily memory maintenance task');

        // Set lastMemoryTaskDate immediately to prevent multiple runs
        // Set memoryTaskRunning flag to prevent concurrent runs
        lastMemoryTaskDate = today;
        memoryTaskRunning = true;

        runDailyMemoryTask(today)
          .then(() => {
            logger.info({ date: today }, 'Daily memory task completed');
          })
          .catch((error) => {
            logger.error({ date: today, error }, 'Daily memory task failed');
          })
          .finally(() => {
            memoryTaskRunning = false;
          });
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Check if this is a host command task (context_mode = 'host')
        // Host commands run directly on the host, not in containers
        if (currentTask.context_mode === 'host') {
          // Execute host command in background
          runHostCommand(
            currentTask.prompt,
            currentTask.id,
            deps.sendMessage,
          ).then(({ success, output, error }) => {
            const durationMs = Date.now(); // Approximate
            logTaskRun({
              task_id: currentTask.id,
              run_at: new Date().toISOString(),
              duration_ms: durationMs,
              status: success ? 'success' : 'error',
              result: success ? output : null,
              error: error || null,
            });

            // Update next run time
            let nextRun: string | null = null;
            if (currentTask.schedule_type === 'cron') {
              const interval = CronExpressionParser.parse(currentTask.schedule_value, {
                tz: TIMEZONE,
              });
              nextRun = interval.next().toISOString();
            } else if (currentTask.schedule_type === 'interval') {
              const ms = parseInt(currentTask.schedule_value, 10);
              nextRun = new Date(Date.now() + ms).toISOString();
            }

            updateTaskAfterRun(currentTask.id, nextRun, success ? output.slice(0, 200) : error || 'Failed');
          });
        } else {
          // Regular task: run in container
          deps.queue.enqueueTask(
            currentTask.chat_jid,
            currentTask.id,
            () => runTask(currentTask, deps),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

// Export inter-agent communication function for use by IPC and other modules
export { sendAgentMessage, runHostCommand };
