import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { workflowEngine } from './workflow-engine.js';
import { formatWorkflowStatus, formatWorkflowList, listAvailableWorkflows } from './workflow-router.js';
import { listWorkflows } from './workflow-parser.js';
import { validateJid, validateTaskName, validateCronExpression, validateInterval } from './utils/validation.js';

// IPC message size limit (1MB)
const MAX_IPC_FILE_SIZE = 1024 * 1024;

// Rate limiting for IPC operations
const ipcRateLimit = new Map<string, { count: number; resetTime: number }>();
const IPC_RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const IPC_RATE_LIMIT_MAX = 100; // Max 100 operations per minute per source

// Simple file locking for atomic IPC operations
const lockFiles = new Map<string, { lock: Promise<void>; timestamp: number }>();
const LOCK_TIMEOUT_MS = 5000; // Locks expire after 5 seconds

async function acquireLock(lockPath: string): Promise<() => void> {
  // Clean up expired locks
  const now = Date.now();
  for (const [path, lock] of lockFiles.entries()) {
    if (now - lock.timestamp > LOCK_TIMEOUT_MS) {
      lockFiles.delete(path);
    }
  }

  // Wait for existing lock to be released
  const existing = lockFiles.get(lockPath);
  if (existing) {
    try {
      await Promise.race([
        existing.lock,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Lock wait timeout')), 1000)),
      ]);
    } catch {
      // Lock expired or error - proceed anyway
    }
  }

  // Create new lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  lockFiles.set(lockPath, { lock: lockPromise, timestamp: now });

  return () => {
    lockFiles.delete(lockPath);
    releaseLock!();
  };
}

// Atomically read and delete a file
async function atomicReadAndDelete(filePath: string): Promise<string | null> {
  const lockPath = `${filePath}.lock`;
  const release = await acquireLock(lockPath);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    // Check file size before reading
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_IPC_FILE_SIZE) {
      logger.warn({ filePath, size: stat.size, maxSize: MAX_IPC_FILE_SIZE }, 'IPC file too large, deleting');
      fs.unlinkSync(filePath);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // Use rename for atomic delete (create temp, then rename)
    const tempPath = `${filePath}.deleting-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(filePath, tempPath);
      fs.unlinkSync(tempPath);
    } catch (err) {
      // File might have been processed by another process
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    return content;
  } finally {
    release();
  }
}

/**
 * Check rate limit for IPC operations
 */
function checkIpcRateLimit(source: string): boolean {
  const now = Date.now();
  const limit = ipcRateLimit.get(source);

  if (!limit || now > limit.resetTime) {
    ipcRateLimit.set(source, { count: 1, resetTime: now + IPC_RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (limit.count >= IPC_RATE_LIMIT_MAX) {
    logger.warn({ source, count: limit.count, max: IPC_RATE_LIMIT_MAX }, 'IPC rate limit exceeded');
    return false;
  }

  limit.count++;
  return true;
}

/**
 * Validate IPC message data
 */
function validateIpcMessage(data: unknown): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid message format' };
  }

  const msg = data as Record<string, unknown>;

  // Check for message type
  if (!msg.type || typeof msg.type !== 'string') {
    return { valid: false, error: 'Missing or invalid message type' };
  }

  // Validate based on message type
  switch (msg.type) {
    case 'message':
      if (!msg.chatJid || typeof msg.chatJid !== 'string') {
        return { valid: false, error: 'Missing or invalid chatJid' };
      }
      if (!msg.text || typeof msg.text !== 'string') {
        return { valid: false, error: 'Missing or invalid text' };
      }
      if (msg.text.length > 10000) {
        return { valid: false, error: 'Message text too long (max 10000 chars)' };
      }
      // Validate JID format
      const jidResult = validateJid(msg.chatJid);
      if (!jidResult.valid) {
        return { valid: false, error: `Invalid chatJid: ${jidResult.errors.join(', ')}` };
      }
      break;

    case 'task_create':
      if (!msg.taskName || typeof msg.taskName !== 'string') {
        return { valid: false, error: 'Missing or invalid taskName' };
      }
      if (!msg.prompt || typeof msg.prompt !== 'string') {
        return { valid: false, error: 'Missing or invalid prompt' };
      }
      if (msg.prompt.length > 100000) {
        return { valid: false, error: 'Prompt too long (max 100000 chars)' };
      }
      break;

    case 'task_delete':
      if (!msg.taskId || typeof msg.taskId !== 'string') {
        return { valid: false, error: 'Missing or invalid taskId' };
      }
      break;

    case 'agent_message':
      if (!msg.from || typeof msg.from !== 'string') {
        return { valid: false, error: 'Missing or invalid from' };
      }
      if (!msg.to || typeof msg.to !== 'string') {
        return { valid: false, error: 'Missing or invalid to' };
      }
      if (!msg.message || typeof msg.message !== 'string') {
        return { valid: false, error: 'Missing or invalid message' };
      }
      break;

    default:
      // Unknown type - log but allow through for extensibility
      logger.debug({ type: msg.type }, 'Unknown IPC message type');
  }

  return { valid: true };
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  sendAgentMessage?: (fromAgent: string, toAgent: string, message: string, context?: any) => Promise<void>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      // Both "main" and "lucy" are considered main (Lucy is the primary web entry point)
      const isMain = sourceGroup === MAIN_GROUP_FOLDER || sourceGroup === 'lucy';
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              // Rate limit check
              if (!checkIpcRateLimit(sourceGroup)) {
                logger.warn({ file, sourceGroup }, 'IPC rate limited, skipping file');
                continue;
              }

              // Use atomic read and delete to prevent race conditions
              const content = await atomicReadAndDelete(filePath);
              if (!content) continue; // File already processed

              const data = JSON.parse(content);

              // Validate IPC message
              const validation = validateIpcMessage(data);
              if (!validation.valid) {
                logger.warn({ file, sourceGroup, error: validation.error }, 'Invalid IPC message');
                continue;
              }

              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              // File already deleted by atomicReadAndDelete
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              // Rate limit check
              if (!checkIpcRateLimit(sourceGroup)) {
                logger.warn({ file, sourceGroup }, 'IPC rate limited, skipping file');
                continue;
              }

              // Use atomic read and delete to prevent race conditions
              const content = await atomicReadAndDelete(filePath);
              if (!content) continue; // File already processed

              const data = JSON.parse(content);

              // Validate IPC task
              const validation = validateIpcMessage(data);
              if (!validation.valid) {
                logger.warn({ file, sourceGroup, error: validation.error }, 'Invalid IPC task');
                continue;
              }

              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              // File already deleted by atomicReadAndDelete
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For agent_message
    from?: string;
    to?: string;
    message?: string;
    context?: any;
    // For workflows
    workflowId?: string;
    task?: string;
    runId?: string;
    listType?: 'available' | 'runs';
    // For background_task
    agentFolder?: string;
    description?: string;
    notifyOnComplete?: boolean;
    notifyJid?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        // Validate schedule value
        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          // Validate cron expression
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch (parseError) {
            logger.warn(
              { scheduleValue: data.schedule_value, error: parseError },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval (must be positive number)',
            );
            break;
          }
          // Cap minimum interval to 1 minute to prevent excessive runs
          if (ms < 60000) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Interval too short (minimum 60000ms)',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp for once task',
            );
            break;
          }
          // Prevent scheduling in the past
          if (scheduled.getTime() < Date.now()) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Cannot schedule task in the past',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'agent_message':
      // Agent-to-agent delegation messages
      if (data.from && data.to && data.message) {
        const fromAgent = sourceGroup;
        const toAgent = data.to;

        // Verify source group matches the fromAgent
        if (fromAgent !== data.from) {
          logger.warn(
            { fromAgent, sourceGroup, claimedFrom: data.from },
            'Agent message source mismatch - blocked',
          );
          break;
        }

        // Check if target agent exists
        const targetAgentExists = Object.values(registeredGroups).some(
          g => g.folder === toAgent
        );

        if (!targetAgentExists) {
          logger.warn(
            { toAgent, fromAgent },
            'Cannot send agent message: target agent not registered',
          );
          break;
        }

        // All agents can send messages to other agents
        // This enables the delegation hierarchy
        logger.info(
          { fromAgent, toAgent, messageLength: data.message.length, hasContext: !!data.context },
          'Agent delegation message',
        );

        // Route the message to the target agent
        // Pass through context including sessionKey if available (for WebSocket clients)
        if (deps.sendAgentMessage) {
          await deps.sendAgentMessage(fromAgent, toAgent, data.message, data.context);
        } else {
          logger.warn({ fromAgent, toAgent }, 'sendAgentMessage not implemented yet');
        }
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'start_workflow':
      if (data.workflowId && data.task) {
        // Authorization: groups can only start workflows for themselves
        const targetFolder = data.groupFolder || sourceGroup;
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized workflow start attempt blocked',
          );
          break;
        }

        const runId = await workflowEngine.startRun(data.workflowId, targetFolder, data.task);
        if (runId) {
          logger.info(
            { workflowRunId: runId, workflowId: data.workflowId, targetFolder },
            'Workflow started via IPC',
          );
          // Send status update to the group
          const groupJid = Object.keys(registeredGroups).find(
            (jid) => registeredGroups[jid].folder === targetFolder,
          );
          if (groupJid && deps.sendMessage) {
            await deps.sendMessage(
              groupJid,
              `Started ${data.workflowId} workflow (ID: ${runId.slice(0, 8)}...). Use "workflow status" to check progress.`,
            );
          }
        } else {
          logger.error(
            { workflowId: data.workflowId },
            'Failed to start workflow via IPC',
          );
          if (deps.sendMessage) {
            const groupJid = Object.keys(registeredGroups).find(
              (jid) => registeredGroups[jid].folder === targetFolder,
            );
            if (groupJid) {
              await deps.sendMessage(
                groupJid,
                `Failed to start workflow "${data.workflowId}". Make sure it exists in workflows/ directory.`,
              );
            }
          }
        }
      }
      break;

    case 'workflow_status':
      if (data.runId) {
        // Find run by ID prefix
        const targetFolder = data.groupFolder || sourceGroup;
        const runs = workflowEngine.listWorkflows(targetFolder);
        const run = data.runId
          ? runs.find((r) => r.id.startsWith(data.runId))
          : runs[0];

        if (run) {
          const status = workflowEngine.getStatus(run.id);
          const formatted = formatWorkflowStatus(status);
          const groupJid = Object.keys(registeredGroups).find(
            (jid) => registeredGroups[jid].folder === targetFolder,
          );
          if (groupJid && deps.sendMessage) {
            await deps.sendMessage(groupJid, formatted);
          }
        } else {
          logger.warn({ runId: data.runId }, 'Workflow run not found for status check');
        }
      } else if (data.listType === 'available') {
        const formatted = listAvailableWorkflows();
        const groupJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].folder === sourceGroup,
        );
        if (groupJid && deps.sendMessage) {
          await deps.sendMessage(groupJid, formatted);
        }
      } else if (data.listType === 'runs') {
        const runs = workflowEngine.listWorkflows(sourceGroup);
        const formatted = formatWorkflowList(runs);
        const groupJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].folder === sourceGroup,
        );
        if (groupJid && deps.sendMessage) {
          await deps.sendMessage(groupJid, formatted);
        }
      }
      break;

    case 'list_workflows':
      if (data.listType === 'available' || !data.listType) {
        const formatted = listAvailableWorkflows();
        const groupJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].folder === sourceGroup,
        );
        if (groupJid && deps.sendMessage) {
          await deps.sendMessage(groupJid, formatted);
        }
      } else if (data.listType === 'runs') {
        const runs = workflowEngine.listWorkflows(sourceGroup);
        const formatted = formatWorkflowList(runs);
        const groupJid = Object.keys(registeredGroups).find(
          (jid) => registeredGroups[jid].folder === sourceGroup,
        );
        if (groupJid && deps.sendMessage) {
          await deps.sendMessage(groupJid, formatted);
        }
      }
      break;

    case 'pause_workflow':
      if (data.runId) {
        const targetFolder = data.groupFolder || sourceGroup;
        const runs = workflowEngine.listWorkflows(targetFolder);
        const run = runs.find((r) => r.id.startsWith(data.runId));

        if (run) {
          workflowEngine.pauseRun(run.id);
          logger.info({ workflowRunId: run.id }, 'Workflow paused via IPC');
          const groupJid = Object.keys(registeredGroups).find(
            (jid) => registeredGroups[jid].folder === targetFolder,
          );
          if (groupJid && deps.sendMessage) {
            await deps.sendMessage(
              groupJid,
              `Workflow ${run.id.slice(0, 8)}... paused. Resume with "resume workflow ${run.id.slice(0, 8)}"`,
            );
          }
        }
      }
      break;

    case 'resume_workflow':
      if (data.runId) {
        const targetFolder = data.groupFolder || sourceGroup;
        const runs = workflowEngine.listWorkflows(targetFolder);
        const run = runs.find((r) => r.id.startsWith(data.runId));

        if (run) {
          await workflowEngine.resumeRun(run.id);
          logger.info({ workflowRunId: run.id }, 'Workflow resumed via IPC');
          const groupJid = Object.keys(registeredGroups).find(
            (jid) => registeredGroups[jid].folder === targetFolder,
          );
          if (groupJid && deps.sendMessage) {
            await deps.sendMessage(
              groupJid,
              `Workflow ${run.id.slice(0, 8)}... resumed.`,
            );
          }
        }
      }
      break;

    case 'cancel_workflow':
      if (data.runId) {
        const targetFolder = data.groupFolder || sourceGroup;
        const runs = workflowEngine.listWorkflows(targetFolder);
        const run = runs.find((r) => r.id.startsWith(data.runId));

        if (run) {
          workflowEngine.cancelRun(run.id);
          logger.info({ workflowRunId: run.id }, 'Workflow cancelled via IPC');
          const groupJid = Object.keys(registeredGroups).find(
            (jid) => registeredGroups[jid].folder === targetFolder,
          );
          if (groupJid && deps.sendMessage) {
            await deps.sendMessage(
              groupJid,
              `Workflow ${run.id.slice(0, 8)}... cancelled.`,
            );
          }
        }
      }
      break;

    case 'background_task':
      // Start a background task (long-running, parallel execution)
      // All agents can delegate tasks; source identity is verified via IPC directory path

      // Import the background task starter (will be handled by the websocket module)
      // For now, we just log and acknowledge - the actual task starting is in websocket.ts
      logger.info(
        {
          agentFolder: data.agentFolder || sourceGroup,
          name: data.name,
          prompt: data.prompt?.substring(0, 100),
        },
        'Background task request received via IPC',
      );

      // Write to a special file that the websocket server monitors
      const bgTaskDir = path.join(DATA_DIR, 'ipc', 'background-tasks');
      fs.mkdirSync(bgTaskDir, { recursive: true });
      const bgTaskFile = path.join(bgTaskDir, `request-${Date.now()}.json`);
      fs.writeFileSync(bgTaskFile, JSON.stringify({
        agentFolder: data.agentFolder || sourceGroup,
        name: data.name || 'Background Task',
        description: data.description,
        prompt: data.prompt,
        notifyOnComplete: data.notifyOnComplete !== false,
        notifyJid: data.notifyJid || '120363422227220717@g.us',
        createdAt: new Date().toISOString(),
      }));
      logger.info({ file: bgTaskFile }, 'Background task request written');
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
