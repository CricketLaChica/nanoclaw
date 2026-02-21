import fs from 'fs';
import path from 'path';

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
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
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
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
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

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
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
      // Only main can start background tasks
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Non-main group attempted to start background task');
        return;
      }

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
