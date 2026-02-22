/**
 * Resource Manager for NanoClaw
 * Manages cleanup of containers, files, and other resources
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { withRetry, CircuitBreaker, sleep } from './error-boundary.js';

const execAsync = promisify(exec);

export interface ResourceMetrics {
  containers: number;
  memoryUsageMb: number;
  cpuPercent: number;
  diskUsagePercent: number;
}

/**
 * Resource Manager - handles cleanup, monitoring, and resource limits
 */
export class ResourceManager {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly dockerCircuitBreaker = new CircuitBreaker(3, 30000, 'docker');

  /**
   * Start periodic resource monitoring and cleanup
   */
  startMonitoring(cleanupIntervalMs: number = 300000): void {
    if (this.cleanupInterval) {
      logger.warn('Resource monitoring already running');
      return;
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        await this.performCleanup();
        const metrics = await this.getMetrics();
        logger.debug(metrics, 'Resource metrics');
      } catch (error) {
        logger.error({ error }, 'Error during resource cleanup');
      }
    }, cleanupIntervalMs);

    logger.info({ intervalMs: cleanupIntervalMs }, 'Resource monitoring started');
  }

  /**
   * Stop resource monitoring
   */
  stopMonitoring(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('Resource monitoring stopped');
    }
  }

  /**
   * Get current resource metrics
   */
  async getMetrics(): Promise<ResourceMetrics> {
    const [containers, memoryUsageMb, cpuPercent, diskUsagePercent] = await Promise.all([
      this.getContainerCount(),
      this.getMemoryUsage(),
      this.getCpuUsage(),
      this.getDiskUsage(),
    ]);

    return { containers, memoryUsageMb, cpuPercent, diskUsagePercent };
  }

  /**
   * Perform cleanup of stale resources
   */
  async performCleanup(): Promise<void> {
    logger.debug('Starting resource cleanup');

    // Clean up orphaned containers
    await this.cleanupOrphanedContainers();

    // Clean up old IPC files
    await this.cleanupOldIpcFiles();

    // Clean up old log files
    await this.cleanupOldLogFiles();

    logger.debug('Resource cleanup completed');
  }

  /**
   * Get number of running containers
   */
  private async getContainerCount(): Promise<number> {
    try {
      const { stdout } = await this.dockerCircuitBreaker.execute(() =>
        execAsync('docker ps --filter "name=nanoclaw-" --format "{{.Names}}" | wc -l'),
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get memory usage in MB
   */
  private async getMemoryUsage(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        process.platform === 'darwin'
          ? 'ps -o rss= -p ' + process.pid
          : 'cat /proc/self/status | grep VmRSS | awk \'{print $2}\'',
      );
      const kb = parseInt(stdout.trim(), 10) || 0;
      return Math.round(kb / 1024);
    } catch {
      return 0;
    }
  }

  /**
   * Get CPU usage percentage
   */
  private async getCpuUsage(): Promise<number> {
    try {
      const startUsage = process.cpuUsage();
      await sleep(100);
      const endUsage = process.cpuUsage(startUsage);
      const total = endUsage.user + endUsage.system;
      return Math.round((total / 1000) / 100); // Convert to percentage
    } catch {
      return 0;
    }
  }

  /**
   * Get disk usage percentage
   */
  private async getDiskUsage(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        process.platform === 'darwin'
          ? 'df -h / | tail -1 | awk \'{print $5}\' | tr -d "%"'
          : 'df -h . | tail -1 | awk \'{print $5}\' | tr -d "%"',
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Clean up containers that are no longer being tracked
   */
  private async cleanupOrphanedContainers(): Promise<void> {
    try {
      // Get containers older than 24 hours that might be orphaned
      const { stdout } = await this.dockerCircuitBreaker.execute(() =>
        execAsync(
          'docker ps -a --filter "name=nanoclaw-" --format "{{.Names}} {{.Status}}"',
        ),
      );

      const lines = stdout.trim().split('\n').filter(Boolean);
      const now = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

      for (const line of lines) {
        const [name, ...statusParts] = line.split(' ');
        const status = statusParts.join(' ');

        // Check for exited containers
        if (status.includes('Exited')) {
          logger.debug({ container: name }, 'Removing exited container');
          await execAsync(`docker rm ${name}`).catch(() => {});
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to cleanup orphaned containers');
    }
  }

  /**
   * Clean up old IPC files that might have been left behind
   */
  private async cleanupOldIpcFiles(ipcBaseDir: string = './data/ipc'): Promise<void> {
    const ipcPath = path.resolve(ipcBaseDir);
    if (!fs.existsSync(ipcPath)) return;

    const maxAgeMs = 60 * 60 * 1000; // 1 hour
    const now = Date.now();

    const cleanDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanDir(fullPath);
          } else {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > maxAgeMs) {
              fs.unlinkSync(fullPath);
              logger.debug({ file: fullPath }, 'Cleaned up old IPC file');
            }
          }
        }
      } catch (error) {
        // Ignore errors during cleanup
      }
    };

    cleanDir(ipcPath);
  }

  /**
   * Clean up log files older than retention period
   */
  private async cleanupOldLogFiles(logsDir: string = './logs'): Promise<void> {
    const logsPath = path.resolve(logsDir);
    if (!fs.existsSync(logsPath)) return;

    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    try {
      const files = fs.readdirSync(logsPath);
      for (const file of files) {
        const fullPath = path.join(logsPath, file);
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          logger.debug({ file: fullPath }, 'Cleaned up old log file');
        }
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  }

  /**
   * Force stop all nanoclaw containers
   */
  async stopAllContainers(): Promise<void> {
    try {
      await this.dockerCircuitBreaker.execute(async () => {
        const { stdout } = await execAsync(
          'docker ps --filter "name=nanoclaw-" --format "{{.Names}}"',
        );
        const containers = stdout.trim().split('\n').filter(Boolean);

        for (const container of containers) {
          try {
            await execAsync(`docker stop -t 5 ${container}`);
            logger.debug({ container }, 'Stopped container');
          } catch (error) {
            logger.warn({ container, error }, 'Failed to stop container');
          }
        }
      });
    } catch (error) {
      logger.error({ error }, 'Failed to stop containers');
    }
  }

  /**
   * Check if system is under heavy load
   */
  async isUnderHeavyLoad(): Promise<boolean> {
    const metrics = await this.getMetrics();

    return (
      metrics.cpuPercent > 80 ||
      metrics.memoryUsageMb > 1000 ||
      metrics.diskUsagePercent > 90
    );
  }
}

// Global resource manager instance
export const resourceManager = new ResourceManager();
