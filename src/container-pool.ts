/**
 * Container Pool Manager
 * Manages persistent agent containers instead of creating new ones per message
 */

import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

import { runContainerAgent, ContainerInput, ContainerOutput } from './container-runner.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

interface PooledContainer {
  containerName: string;
  groupFolder: string;
  pid: number;
  createdAt: Date;
  lastUsedAt: Date;
  messageCount: number;
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
  // NOTE: IPC-based reuse is disabled until containers support long-running mode with polling
  // For now, we always create new containers but track them for cleanup
  if (existing) {
    const idleTime = now.getTime() - existing.lastUsedAt.getTime();

    // Check if container should be recycled (too old or too many messages)
    if (existing.messageCount >= MAX_MESSAGES_PER_CONTAINER || idleTime >= CONTAINER_REUSE_TIMEOUT) {
      logger.info(
        { groupFolder, containerName: existing.containerName, messageCount: existing.messageCount, idleTime },
        'Recycling container (too many messages or idle too long)'
      );
      await stopContainer(existing);
      runningContainers.delete(groupFolder);
    } else {
      // Container exists but we don't reuse it (IPC not supported yet)
      // Just update the stats to show we checked it
      logger.debug(
        { groupFolder, containerName: existing.containerName, messageCount: existing.messageCount },
        'Container exists but creating new one (IPC reuse not yet implemented)'
      );
      // Don't return - continue to create new container below
    }
  }

  // No existing container (or we just recycled it) - create a new one
  // Note: IPC-based reuse will be implemented once containers support long-running mode
  logger.info({ groupFolder, inputLength: input.prompt.length }, 'Creating new container (IPC reuse not yet implemented)');

  const startTime = Date.now();
  const containerOutput = await runContainerAgent(group, input, onProcess, onOutput);
  const duration = Date.now() - startTime;

  // Extract container name from the output/logs
  // The container is created with name format: nanoclaw-{groupFolder}-{timestamp}
  // We'll get the actual container name from Docker after creation
  const containerName = await findContainerName(groupFolder);

  if (containerName) {
    const proc = spawn('docker', ['inspect', '-f', '{{.State.Pid}}', containerName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let pid = 0;
    proc.stdout.on('data', (data) => {
      pid = parseInt(data.toString().trim());
    });

    await new Promise((resolve) => {
      proc.on('close', resolve);
    });

    const pooled: PooledContainer = {
      containerName,
      groupFolder,
      pid,
      createdAt: now,
      lastUsedAt: now,
      messageCount: 1,
    };

    runningContainers.set(groupFolder, pooled);

    logger.info(
      {
        groupFolder,
        containerName,
        pid,
        duration,
        outputStatus: containerOutput.status,
        poolSize: runningContainers.size,
      },
      'Container added to pool'
    );
  } else {
    logger.warn({ groupFolder, duration, outputStatus: containerOutput.status }, 'Container created but name not found');
  }

  return { containerOutput, wasNew: true };
}

/**
 * Send a message to an existing container via IPC
 */
async function sendMessageToContainer(
  container: PooledContainer,
  input: ContainerInput
): Promise<ContainerOutput> {
  const groupIpcDir = path.join(process.env.DATA_DIR || process.cwd(), 'data', 'ipc', container.groupFolder, 'input');
  const fs = await import('fs');

  // Create a unique filename for this message
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const messagePath = path.join(groupIpcDir, `${messageId}.json`);

  try {
    // Write the message as an IPC input file
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(messagePath, JSON.stringify({
      type: 'message',
      text: input.prompt,
    }));

    logger.debug(
      { groupFolder: container.groupFolder, messageId, message: input.prompt.substring(0, 50) },
      'IPC message written, waiting for container to process...'
    );

    // Wait for the container to process and emit output
    // The container will poll for IPC messages and process them
    // We need to monitor for the output marker

    // For now, we'll return a placeholder - the actual output will come via the WebSocket events
    // This is a temporary implementation - in production, we'd wait for the actual output

    return {
      status: 'success',
      result: null, // Will be filled in by actual container output
    };

  } catch (err) {
    logger.error({ groupFolder: container.groupFolder, error: err }, 'Failed to send IPC message');
    return {
      status: 'error',
      result: null,
      error: `Failed to send IPC message: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Find the Docker container name for a given group folder
 */
async function findContainerName(groupFolder: string): Promise<string | null> {
  const { exec } = await import('child_process');

  return new Promise((resolve) => {
    exec(`docker ps --format "{{.Names}}" --filter "name=nanoclaw-${groupFolder}-"`, (err, stdout, stderr) => {
      if (err) {
        logger.warn({ groupFolder, error: err?.message }, 'Failed to find container name');
        resolve(null);
        return;
      }

      const names = stdout.trim().split('\n').filter(n => n);
      if (names.length > 0) {
        // Return the most recent (last) container
        resolve(names[names.length - 1]);
      } else {
        resolve(null);
      }
    });
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
      reason: uptime > CONTAINER_REUSE_TIMEOUT ? 'idle timeout' : 'max messages reached',
    },
    'Stopping container'
  );

  const { exec } = await import('child_process');

  return new Promise((resolve) => {
    // Send close sentinel first to let container know to shut down gracefully
    const closeSentinel = path.join(
      process.env.DATA_DIR || process.cwd(),
      'data',
      'ipc',
      container.groupFolder,
      'input',
      '_close'
    );

    const fs = require('fs');
    fs.mkdirSync(path.dirname(closeSentinel), { recursive: true });
    fs.writeFileSync(closeSentinel, 'close');

    // Wait a moment for the container to notice the sentinel
    setTimeout(() => {
      exec(`docker stop -t 5 ${container.containerName} || docker kill ${container.containerName}`, (err) => {
        if (err) {
          logger.warn(
            { groupFolder: container.groupFolder, containerName: container.containerName, error: err?.message },
            'Failed to stop container'
          );
        }
        resolve();
      });
    }, 500);
  });
}

/**
 * Stop all running containers (for shutdown)
 */
export async function stopAllContainers(): Promise<void> {
  logger.info({ count: runningContainers.size }, 'Stopping all containers');

  const stopPromises = Array.from(runningContainers.values()).map(c => stopContainer(c));
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
    containers: Array.from(runningContainers.values()).map(c => ({
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
  const { exec } = await import('child_process');

  return new Promise((resolve) => {
    exec('docker ps --format "{{.Names}}" --filter "name=nanoclaw-"', (err, stdout, stderr) => {
      if (err) {
        logger.warn({ error: err?.message }, 'Failed to list containers for cleanup');
        resolve();
        return;
      }

      const containers = stdout.trim().split('\n').filter(n => n);
      if (containers.length === 0) {
        logger.debug('No orphaned containers found');
        resolve();
        return;
      }

      logger.info({ count: containers.length, containers }, 'Found orphaned containers, cleaning up');

      // Stop all orphaned containers
      const stopPromises = containers.map(containerName =>
        new Promise<void>((stopResolve) => {
          const closeSentinel = containerName.match(/nanoclaw-([^-]+)-/)?.[1];
          if (closeSentinel) {
            // Try graceful shutdown first
            const sentinelPath = path.join(
              process.env.DATA_DIR || process.cwd(),
              'data',
              'ipc',
              closeSentinel,
              'input',
              '_close'
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
            exec(`docker stop -t 2 ${containerName} || docker kill ${containerName}`, (stopErr) => {
              if (stopErr) {
                logger.warn({ containerName, error: stopErr?.message }, 'Failed to stop orphaned container');
              } else {
                logger.info({ containerName }, 'Stopped orphaned container');
              }
              stopResolve();
            });
          }, 500);
        })
      );

      Promise.all(stopPromises).then(() => resolve());
    });
  });
}
