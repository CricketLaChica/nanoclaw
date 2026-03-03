import { ChildProcess, spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MAIN_GROUP_JID,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';

/**
 * Get current time info in configured timezone
 */
function getLocalTimeInfo(): { date: string; hour: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value || '0';

  return {
    date: `${getPart('year')}-${getPart('month')}-${getPart('day')}`,
    hour: parseInt(getPart('hour'), 10),
  };
}
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
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
import {
  runDailyMemoryTask,
  DailyMemoryTaskResult,
} from './memory-scheduler.js';
import { getRelevantMemories, readPersonalityFile } from './memory.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  // Skip if task is already running (overlap protection)
  if (runningTasks.has(task.id)) {
    logger.warn({ taskId: task.id }, 'Task already running, skipping');
    return;
  }

  runningTasks.add(task.id);
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
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing container stdin',
      );
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
      contextParts.push(
        `**Personality & Core Values:**\n${soulContent.trim()}\n`,
      );
    }

    // Add relevant long-term memories
    const relevantMemories = getRelevantMemories(
      task.group_folder,
      task.prompt,
      5,
    );

    logger.debug(
      {
        taskId: task.id,
        groupFolder: task.group_folder,
        memoryCount: relevantMemories.length,
      },
      'Scheduled task: Memory injection fetched relevant memories',
    );

    if (relevantMemories.length > 0) {
      const memoryText = relevantMemories
        .map((m) => `- [${m.memory_type}] ${m.content}`)
        .join('\n');
      contextParts.push(`**Relevant Memories:**\n${memoryText}\n`);
    }

    if (contextParts.length > 0) {
      promptWithContext = `${contextParts.join('\n\n')}\n\n**Task:** ${task.prompt}`;

      logger.debug(
        { taskId: task.id, contextSize: contextParts.length },
        'Scheduled task: Memory injection added context to prompt',
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
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Prefix with agent name for non-main agents so user knows who sent it
          const resultText = !isMain
            ? `[${group.name}]: ${streamedOutput.result}`
            : streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, resultText);
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

  // Remove from running tasks
  runningTasks.delete(task.id);
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
          reject(
            new Error(
              `Command failed with exit code ${code}: ${stderr || stdout}`,
            ),
          );
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });

    const durationMs = Date.now() - startTime;
    logger.info(
      { taskId, durationMs, outputLength: output.length },
      'Host command completed',
    );

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
      'Agent message sent via IPC',
    );

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      { fromAgent, toAgent, error },
      'Failed to send agent message via IPC',
    );

    return { success: false, error };
  }
}

let schedulerRunning = false;
let lastMemoryTaskDate: string | null = null;
let memoryTaskRunning = false;

// Track currently running tasks to prevent overlap
const runningTasks = new Set<string>();

function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression, { tz: TIMEZONE });
    return true;
  } catch {
    return false;
  }
}

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
      // Run at 2 AM local time (configurable)
      const { date: today, hour: currentTime } = getLocalTimeInfo();

      // Run memory task once per day at 2 AM local time
      if (
        lastMemoryTaskDate !== today &&
        currentTime >= 2 &&
        !memoryTaskRunning
      ) {
        logger.info(
          { date: today, timezone: TIMEZONE },
          'Running daily memory maintenance task',
        );

        // Set lastMemoryTaskDate immediately to prevent multiple runs
        // Set memoryTaskRunning flag to prevent concurrent runs
        lastMemoryTaskDate = today;
        memoryTaskRunning = true;

        runDailyMemoryTask(today)
          .then(async (result) => {
            logger.info({ date: today }, 'Daily memory task completed');

            // Send notification to main group
            const summary = formatDailyTaskSummary(result);
            if (deps.sendMessage) {
              await deps.sendMessage(MAIN_GROUP_JID, summary);
            }

            // Save markdown to workspace
            saveDailyTaskSummaryToWorkspace(result);
          })
          .catch(async (error) => {
            logger.error({ date: today, error }, 'Daily memory task failed');

            // Send failure notification
            if (deps.sendMessage) {
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              await deps.sendMessage(
                MAIN_GROUP_JID,
                `Daily memory task failed: ${errorMsg}`,
              );
            }
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

        // Skip if task is already running (overlap protection)
        if (runningTasks.has(task.id)) {
          logger.warn(
            { taskId: task.id },
            'Task already running, skipping to prevent overlap',
          );
          continue;
        }

        // Check if this is a workflow task
        if (currentTask.task_type === 'workflow' && currentTask.workflow_id) {
          // Mark as running
          runningTasks.add(currentTask.id);

          // Execute workflow in background
          (async () => {
            const startTime = Date.now();
            const MAX_POLLING_TIME = 3600000; // 1 hour max polling time
            const POLL_INTERVAL = 2000; // 2 seconds

            try {
              const { workflowEngine } = await import('./workflow-engine.js');

              // Parse input from prompt format: "workflow:{workflow_id}:{input}"
              // The input may be empty if just "workflow:{workflow_id}"
              const promptParts = currentTask.prompt.split(':');
              let workflowInput = '';
              if (promptParts.length > 2) {
                workflowInput = promptParts.slice(2).join(':').trim();
              }

              logger.info(
                {
                  taskId: currentTask.id,
                  workflowId: currentTask.workflow_id,
                  input: workflowInput,
                },
                'Starting scheduled workflow',
              );

              // Start workflow run
              const runId = await workflowEngine.startRun(
                currentTask.workflow_id!,
                currentTask.group_folder,
                workflowInput || 'Scheduled workflow execution',
              );

              if (!runId) {
                throw new Error(
                  `Failed to start workflow ${currentTask.workflow_id}`,
                );
              }

              // Wait for workflow to complete (poll for status with timeout)
              const { getWorkflowStatus } = await import('./workflow-db.js');
              let status = await getWorkflowStatus(runId);
              let pollCount = 0;
              const maxPolls = MAX_POLLING_TIME / POLL_INTERVAL;

              while (
                status &&
                (status.run.status === 'pending' ||
                  status.run.status === 'running')
              ) {
                await new Promise((resolve) =>
                  setTimeout(resolve, POLL_INTERVAL),
                );
                status = await getWorkflowStatus(runId);
                pollCount++;

                // Safety check to prevent infinite polling
                if (pollCount > maxPolls) {
                  logger.error(
                    { taskId: currentTask.id, runId, pollCount },
                    'Workflow polling timeout',
                  );
                  throw new Error('Workflow execution timeout');
                }

                // If status becomes null/undefined, stop polling
                if (!status || !status.run) {
                  logger.warn(
                    { taskId: currentTask.id, runId },
                    'Workflow status became null during polling',
                  );
                  break;
                }
              }

              const durationMs = Date.now() - startTime;
              const finalStatus = status?.run?.status || 'unknown';
              const completed = finalStatus === 'completed';

              logger.info(
                {
                  taskId: currentTask.id,
                  runId,
                  status: finalStatus,
                  durationMs,
                },
                'Scheduled workflow completed',
              );

              // Send notification to user
              await deps.sendMessage(
                currentTask.chat_jid,
                `Workflow ${currentTask.workflow_id} ${completed ? 'completed' : 'failed'} (${status?.progress.completed || 0}/${status?.progress.total || 0} steps)`,
              );

              logTaskRun({
                task_id: currentTask.id,
                run_at: new Date().toISOString(),
                duration_ms: durationMs,
                status: completed ? 'success' : 'error',
                result: completed ? `Workflow completed: ${runId}` : null,
                error: completed ? null : `Workflow ${finalStatus}`,
              });

              // Update next run time
              let nextRun: string | null = null;
              if (currentTask.schedule_type === 'cron') {
                const interval = CronExpressionParser.parse(
                  currentTask.schedule_value,
                  {
                    tz: TIMEZONE,
                  },
                );
                const next = interval.next();
                if (next) nextRun = next.toISOString();
              } else if (currentTask.schedule_type === 'interval') {
                const ms = parseInt(currentTask.schedule_value, 10);
                nextRun = new Date(Date.now() + ms).toISOString();
              }

              updateTaskAfterRun(
                currentTask.id,
                nextRun,
                completed
                  ? `Workflow completed: ${runId}`
                  : `Workflow ${finalStatus}`,
              );
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              logger.error(
                { taskId: currentTask.id, error },
                'Scheduled workflow failed',
              );

              logTaskRun({
                task_id: currentTask.id,
                run_at: new Date().toISOString(),
                duration_ms: Date.now() - startTime,
                status: 'error',
                result: null,
                error,
              });

              await deps.sendMessage(
                currentTask.chat_jid,
                `Workflow execution failed: ${error}`,
              );

              // Still update next run time for recurring workflows
              let nextRun: string | null = null;
              if (currentTask.schedule_type === 'cron') {
                const interval = CronExpressionParser.parse(
                  currentTask.schedule_value,
                  {
                    tz: TIMEZONE,
                  },
                );
                const next = interval.next();
                if (next) nextRun = next.toISOString();
              } else if (currentTask.schedule_type === 'interval') {
                const ms = parseInt(currentTask.schedule_value, 10);
                nextRun = new Date(Date.now() + ms).toISOString();
              }

              updateTaskAfterRun(currentTask.id, nextRun, `Error: ${error}`);
            }
          })().finally(() => {
            runningTasks.delete(currentTask.id);
          });
        } else if (currentTask.context_mode === 'host') {
          // Check if this is a host command task (context_mode = 'host')
          // Host commands run directly on the host, not in containers
          // Mark as running
          runningTasks.add(currentTask.id);

          // Execute host command in background
          runHostCommand(currentTask.prompt, currentTask.id, deps.sendMessage)
            .then(({ success, output, error }) => {
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
                const interval = CronExpressionParser.parse(
                  currentTask.schedule_value,
                  {
                    tz: TIMEZONE,
                  },
                );
                nextRun = interval.next().toISOString();
              } else if (currentTask.schedule_type === 'interval') {
                const ms = parseInt(currentTask.schedule_value, 10);
                nextRun = new Date(Date.now() + ms).toISOString();
              }

              updateTaskAfterRun(
                currentTask.id,
                nextRun,
                success ? output.slice(0, 200) : error || 'Failed',
              );
            })
            .finally(() => {
              runningTasks.delete(currentTask.id);
            });
        } else {
          // Regular task: run in container
          deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
            runTask(currentTask, deps),
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

const DAILY_TASK_WORKSPACE_DIR = path.join(DATA_DIR, 'workspace', 'daily-2am');

function formatDailyTaskSummary(result: DailyMemoryTaskResult): string {
  const durationSec = Math.round(result.duration / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const remainingSec = durationSec % 60;
  const durationStr =
    durationMin > 0 ? `~${durationMin} minutes` : `~${remainingSec} seconds`;

  let summary = `📊 *Daily Memory Task Complete*\n\n`;
  summary += `*Date:* ${result.date}\n`;
  summary += `*Duration:* ${durationStr}\n`;
  summary += `*Agents Processed:* ${result.agentsProcessed.length}\n\n`;
  summary += `*What it did:*\n`;
  summary += `1. Ran daily memory maintenance task for all agents (${result.agentsProcessed.length} agents)\n`;
  summary += `2. Processed conversation histories and extracted memories from each agent's conversations\n`;
  summary += `3. Saved important memories (importance >= 3) to the database\n`;
  summary += `4. Linked related memories together\n`;
  summary += `5. Created daily summaries for each agent\n`;
  summary += `6. Archived old conversations (older than 30 days)\n`;
  summary += `7. Applied importance decay to old memories\n`;

  if (result.errors.length > 0) {
    summary += `\n⚠️ *Errors:*\n`;
    for (const err of result.errors) {
      summary += `- ${err}\n`;
    }
  }

  return summary;
}

function saveDailyTaskSummaryToWorkspace(result: DailyMemoryTaskResult): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(DAILY_TASK_WORKSPACE_DIR)) {
      fs.mkdirSync(DAILY_TASK_WORKSPACE_DIR, { recursive: true });
    }

    const filename = `${result.date}.md`;
    const filepath = path.join(DAILY_TASK_WORKSPACE_DIR, filename);

    const durationSec = Math.round(result.duration / 1000);
    const durationMin = Math.floor(durationSec / 60);
    const remainingSec = durationSec % 60;
    const durationStr =
      durationMin > 0 ? `~${durationMin} minutes` : `~${remainingSec} seconds`;

    let content = `# Daily Memory Task - ${result.date}\n\n`;
    content += `## Execution details\n`;
    content += `- **Date:** ${result.date}\n`;
    content += `- **Duration:** ${durationStr}\n`;
    content += `- **Agents Processed:** ${result.agentsProcessed.length}\n\n`;
    content += `## What it did\n`;
    content += `1. Ran daily memory maintenance task for all agents (${result.agentsProcessed.length} agents)\n`;
    content += `2. Processed conversation histories and extracted memories from each agent's conversations\n`;
    content += `3. Saved important memories (importance >= 3) to the database\n`;
    content += `4. Linked related memories together\n`;
    content += `5. Created daily summaries for each agent\n`;
    content += `6. Archived old conversations (older than 30 days)\n`;
    content += `7. Applied importance decay to old memories\n`;

    if (result.errors.length > 0) {
      content += `\n## Errors\n\n`;
      for (const err of result.errors) {
        content += `- ${err}\n`;
      }
    }

    fs.writeFileSync(filepath, content);
    logger.info({ filepath }, 'Daily task summary saved to workspace');
  } catch (error) {
    logger.error({ error }, 'Failed to save daily task summary to workspace');
  }
}
