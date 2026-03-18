/**
 * Container Pool Manager
 * Manages persistent agent containers instead of creating new ones per message
 */

import { ChildProcess, exec } from 'child_process';
import path from 'path';
import fs from 'fs';

import {
  runContainerAgent,
  ContainerInput,
  ContainerOutput,
} from './container-runner.js';
import { DATA_DIR } from './config.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface PooledContainer {
  containerName: string;
  groupFolder: string;
  pid: number;
  createdAt: Date;
  lastUsedAt: Date;
  messageCount: number;
  process: ChildProcess | null; // Keep reference to running process
}

// Map of group folder → running container
const runningContainers = new Map<string, PooledContainer>();


// Container reuse settings
const MAX_MESSAGES_PER_CONTAINER = 100; // Recycle after N messages
const CONTAINER_REUSE_TIMEOUT = 5 * 60 * 1000; // 5 minutes - recycle if idle this long

/**
 * Get or create a container for the given group
 */
export async function getOrCreateContainer(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{ containerOutput: ContainerOutput; wasNew: boolean }> {
  const groupFolder = group.folder;

  // Check if we have a running container for this group
  const existing = runningContainers.get(groupFolder);
  const now = new Date();

  // Decide whether to reuse existing container
  if (existing) {
    const idleTime = now.getTime() - existing.lastUsedAt.getTime();

    // Check if container should be recycled (too old or too many messages)
    if (
      existing.messageCount >= MAX_MESSAGES_PER_CONTAINER ||
      idleTime >= CONTAINER_REUSE_TIMEOUT
    ) {
      logger.info(
        {
          groupFolder,
          containerName: existing.containerName,
          messageCount: existing.messageCount,
          idleTime,
        },
        'Recycling container (too many messages or idle too long)',
      );
      await stopContainer(existing);
      runningContainers.delete(groupFolder);
    } else if (
      existing.process &&
      !existing.process.killed &&
      existing.process.exitCode === null &&
      existing.process.signalCode === null
    ) {
      // Verify Docker container is still running before reusing
      const containerRunning = await new Promise<boolean>((resolve) => {
        exec(
          `docker inspect -f '{{.State.Running}}' ${existing.containerName}`,
          (err, stdout) => {
            if (err || !stdout) {
              resolve(false);
            } else {
              resolve(stdout.trim() === 'true');
            }
          },
        );
      });

      if (!containerRunning) {
        logger.info(
          { groupFolder, containerName: existing.containerName },
          'Docker container not running, removing from pool',
        );
        runningContainers.delete(groupFolder);
      } else {
        // REUSE the existing container by sending another message
        logger.info(
          {
            groupFolder,
            containerName: existing.containerName,
            messageCount: existing.messageCount,
            pid: existing.process.pid,
          },
          'Reusing existing container',
        );

        const containerOutput = await sendToRunningContainer(
          existing,
          input,
          onOutput,
        );
        const duration = Date.now() - now.getTime();

        // Update stats
        existing.lastUsedAt = new Date();
        existing.messageCount++;

        logger.info(
          {
            groupFolder,
            containerName: existing.containerName,
            duration,
            messageCount: existing.messageCount,
          },
          'Container request completed (reused)',
        );

        return { containerOutput, wasNew: false };
      }
    } else {
      // Container exists but process is dead
      const proc = existing.process;
      const reason =
        proc?.exitCode !== null
          ? `exit code ${proc!.exitCode}`
          : proc?.signalCode !== null
            ? `signal ${proc!.signalCode}`
            : 'process not available';
      logger.info(
        { groupFolder, containerName: existing.containerName, reason },
        'Container process dead, removing from pool',
      );
      runningContainers.delete(groupFolder);
    }
  }

  // No existing container - create a new one.
  // runContainerAgent has a built-in per-group spawn lock, so concurrent calls
  // for the same group are serialised there automatically.
  logger.info(
    { groupFolder, inputLength: input.prompt.length },
    'Creating new container',
  );

  const startTime = Date.now();

  // Wrap onProcess to register the container in the pool as soon as it starts
  const wrappedOnProcess = (proc: ChildProcess, containerName: string) => {
    const pooledContainer: PooledContainer = {
      containerName,
      groupFolder,
      pid: proc.pid || 0,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      messageCount: 1,
      process: proc,
    };
    runningContainers.set(groupFolder, pooledContainer);
    logger.info({ groupFolder, containerName }, 'Container registered in pool');

    // Auto-remove when the process exits
    proc.on('close', () => {
      const current = runningContainers.get(groupFolder);
      if (current && current.containerName === containerName) {
        runningContainers.delete(groupFolder);
        logger.info({ groupFolder, containerName }, 'Container removed from pool on exit');
      }
    });

    onProcess(proc, containerName);
  };

  const containerOutput = await runContainerAgent(
    group,
    input,
    wrappedOnProcess,
    onOutput,
  );
  const duration = Date.now() - startTime;
  logger.info({ groupFolder, duration }, 'Container request completed');
  return { containerOutput, wasNew: true };
}

/**
 * Send a message to an already-running container via IPC file
 * After the first query, containers poll for IPC messages instead of reading stdin
 */
async function sendToRunningContainer(
  container: PooledContainer,
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupIpcDir = path.join(
    DATA_DIR,
    'ipc',
    container.groupFolder,
    'input',
  );

  return new Promise((resolve, reject) => {
    if (!container.process) {
      reject(new Error('Container process not available'));
      return;
    }

    const { process } = container;
    let parseBuffer = '';
    let hadOutput = false;
    let finalOutput: ContainerOutput | null = null;

    // Set up timeout
    const timeout = setTimeout(() => {
      if (!hadOutput) {
        reject(new Error('Container timeout - no output received'));
      }
    }, 60000); // 60 second timeout

    // Read stdout
    const dataHandler = (data: Buffer) => {
      const chunk = data.toString();
      parseBuffer += chunk;

      // Look for output markers
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break; // Incomplete pair

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          finalOutput = JSON.parse(jsonStr);
          hadOutput = true;
          clearTimeout(timeout);
          // Remove handler to prevent stale processing of subsequent output
          process.stdout?.off('data', dataHandler);

          // Call onOutput callback if provided
          if (onOutput && finalOutput) {
            onOutput(finalOutput).catch((err) => {
              logger.error({ error: err }, 'Error in onOutput callback');
            });
          }
        } catch (err) {
          logger.warn(
            { error: err, jsonStr },
            'Failed to parse container output',
          );
        }
      }
    };

    // Attach handler if stdout exists
    if (process.stdout) {
      process.stdout.on('data', dataHandler);
    }

    // Send input via IPC file (container polls for messages after first query)
    const messageId = Date.now() + '-' + Math.random().toString(36).slice(2);
    const ipcFile = path.join(groupIpcDir, `${messageId}.json`);

    try {
      fs.mkdirSync(groupIpcDir, { recursive: true });
      const ipcMessage = {
        type: 'message',
        text: input.prompt,
      };
      fs.writeFileSync(ipcFile, JSON.stringify(ipcMessage));
      logger.info(
        {
          groupFolder: container.groupFolder,
          ipcFile,
          prompt: input.prompt.substring(0, 50),
        },
        'Sent message to container via IPC',
      );
    } catch (err) {
      process.stdout?.off('data', dataHandler);
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to write IPC file: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    // Wait for output (with timeout for subsequent messages)
    // Also clear the 60s no-output timeout to prevent double-rejection
    setTimeout(() => {
      process.stdout?.off('data', dataHandler);
      clearTimeout(timeout);
      if (hadOutput && finalOutput) {
        resolve(finalOutput);
      } else {
        reject(new Error('Container did not produce output'));
      }
    }, 30000); // 30 second wait for output after sending message
  });
}

/**
 * Stop a container and remove it from the pool
 */
async function stopContainer(container: PooledContainer): Promise<void> {
  const uptime = Date.now() - container.createdAt.getTime();
  const messageCount = container.messageCount;

  logger.info(
    {
      groupFolder: container.groupFolder,
      containerName: container.containerName,
      pid: container.pid,
      uptime,
      messageCount,
      reason:
        messageCount >= MAX_MESSAGES_PER_CONTAINER
          ? 'max messages reached'
          : 'idle timeout',
    },
    'Stopping container',
  );

  return new Promise((resolve) => {
    // Send close sentinel first to let container know to shut down gracefully
    const closeSentinel = path.join(
      DATA_DIR,
      'ipc',
      container.groupFolder,
      'input',
      '_close',
    );

    fs.mkdirSync(path.dirname(closeSentinel), { recursive: true });
    fs.writeFileSync(closeSentinel, 'close');

    // Wait a moment for the container to notice the sentinel
    setTimeout(() => {
      exec(
        `docker stop -t 5 ${container.containerName} || docker kill ${container.containerName}`,
        (err) => {
          if (err) {
            logger.warn(
              {
                groupFolder: container.groupFolder,
                containerName: container.containerName,
                error: err?.message,
              },
              'Failed to stop container',
            );
          }
          resolve();
        },
      );
    }, 500);
  });
}

/**
 * Stop all running containers (for shutdown)
 */
export async function stopAllContainers(): Promise<void> {
  logger.info({ count: runningContainers.size }, 'Stopping all containers');

  const stopPromises = Array.from(runningContainers.values()).map((c) =>
    stopContainer(c),
  );
  await Promise.all(stopPromises);

  runningContainers.clear();
}

/**
 * Get statistics about the container pool
 */
export function getContainerStats(): {
  totalContainers: number;
  containers: Array<{
    groupFolder: string;
    containerName: string;
    messageCount: number;
    uptime: number;
    idleTime: number;
  }>;
} {
  return {
    totalContainers: runningContainers.size,
    containers: Array.from(runningContainers.values()).map((c) => ({
      groupFolder: c.groupFolder,
      containerName: c.containerName,
      messageCount: c.messageCount,
      uptime: Date.now() - c.createdAt.getTime(),
      idleTime: Date.now() - c.lastUsedAt.getTime(),
    })),
  };
}

/**
 * Clean up orphaned NanoClaw containers on startup
 * Removes containers that were left running after a crash/restart
 */
export async function cleanupOrphanedContainers(): Promise<void> {
  return new Promise((resolve) => {
    exec(
      'docker ps --format "{{.Names}}" --filter "name=nanoclaw-"',
      (err, stdout, stderr) => {
        if (err) {
          logger.warn(
            { error: err?.message },
            'Failed to list containers for cleanup',
          );
          resolve();
          return;
        }

        const containers = stdout
          .trim()
          .split('\n')
          .filter((n) => n);
        if (containers.length === 0) {
          logger.debug('No orphaned containers found');
          resolve();
          return;
        }

        logger.info(
          { count: containers.length, containers },
          'Found orphaned containers, cleaning up',
        );

        // Stop all orphaned containers
        const stopPromises = containers.map(
          (containerName) =>
            new Promise<void>((stopResolve) => {
              // Container names are nanoclaw-{folder}-{8char-uuid}
              // Extract folder by stripping prefix and last 9 chars (-xxxxxxxx)
              const folderMatch = containerName.match(/^nanoclaw-(.+)-[a-f0-9]{8}$/);
              const closeSentinel = folderMatch?.[1];
              if (closeSentinel) {
                // Try graceful shutdown first
                const sentinelPath = path.join(
                  DATA_DIR,
                  'ipc',
                  closeSentinel,
                  'input',
                  '_close',
                );
                try {
                  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
                  fs.writeFileSync(sentinelPath, 'close');
                } catch (sentinelErr) {
                  // Ignore sentinel errors
                }
              }

              // Force stop after brief delay
              setTimeout(() => {
                exec(
                  `docker stop -t 2 ${containerName} || docker kill ${containerName}`,
                  (stopErr) => {
                    if (stopErr) {
                      logger.warn(
                        { containerName, error: stopErr?.message },
                        'Failed to stop orphaned container',
                      );
                    } else {
                      logger.info(
                        { containerName },
                        'Stopped orphaned container',
                      );
                    }
                    stopResolve();
                  },
                );
              }, 500);
            }),
        );

        Promise.all(stopPromises).then(() => resolve());
      },
    );
  });
}
