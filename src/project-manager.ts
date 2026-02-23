/**
 * Project Manager - Manages deployed web projects
 *
 * Allows starting/stopping npm-based projects (Next.js, Vite, etc.)
 * from the web dashboard, tracking running servers and their logs.
 */
import { spawn, ChildProcess, execSync } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import os from 'os';

const PROJECTS_DIR = path.join(DATA_DIR, 'workspace');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const MAX_RUNNING_PROJECTS = 10;
const MAX_LOG_LENGTH = 10000; // Max chars per log line

/**
 * Find npm binary path - checks common locations
 */
function findNpmPath(): string {
  // Common npm locations to check
  const possiblePaths = [
    // nvm (check current user's nvm)
    path.join(os.homedir(), '.nvm/versions/node'),
    // fnm
    path.join(os.homedir(), '.fnm/node-versions'),
    // Homebrew on Apple Silicon
    '/opt/homebrew/bin',
    // Homebrew on Intel
    '/usr/local/bin',
    // System
    '/usr/bin',
  ];

  // First, try to find node versions directory and get the latest
  for (const basePath of possiblePaths) {
    if (basePath.includes('nvm/versions/node') || basePath.includes('fnm')) {
      try {
        if (fs.existsSync(basePath)) {
          const versions = fs.readdirSync(basePath).filter(v => v.startsWith('v'));
          if (versions.length > 0) {
            // Sort versions and get the latest
            versions.sort((a, b) => {
              const aParts = a.replace('v', '').split('.').map(Number);
              const bParts = b.replace('v', '').split('.').map(Number);
              for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                if ((aParts[i] || 0) !== (bParts[i] || 0)) {
                  return (bParts[i] || 0) - (aParts[i] || 0);
                }
              }
              return 0;
            });
            const latestVersion = versions[0];
            const npmPath = path.join(basePath, latestVersion, 'bin', 'npm');
            if (fs.existsSync(npmPath)) {
              logger.info({ npmPath }, 'Found npm');
              return npmPath;
            }
          }
        }
      } catch {
        // Continue to next path
      }
    } else {
      const npmPath = path.join(basePath, 'npm');
      if (fs.existsSync(npmPath)) {
        logger.info({ npmPath }, 'Found npm');
        return npmPath;
      }
    }
  }

  // Fallback: try to find npm using which (might not work in launchd)
  try {
    const result = execSync('which npm', { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // Ignore
  }

  // Last resort: just use 'npm' and hope it's in PATH
  logger.warn('Could not find npm, using fallback');
  return 'npm';
}

// Cache the npm path
let npmPath: string | null = null;

function getNpmPath(): string {
  if (!npmPath) {
    npmPath = findNpmPath();
  }
  return npmPath;
}

/**
 * Build environment with proper PATH for node/npm
 */
function buildEnv(port: number): NodeJS.ProcessEnv {
  const homeDir = os.homedir();

  // Common paths where node/npm might be installed
  const nodePaths = [
    // nvm default
    path.join(homeDir, '.nvm/versions/node'),
    // fnm
    path.join(homeDir, '.fnm'),
    // Homebrew Apple Silicon
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    // Homebrew Intel
    '/usr/local/bin',
    '/usr/local/sbin',
    // System
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  // Find all node version bin directories
  const binPaths: string[] = [];
  for (const basePath of nodePaths) {
    if (basePath.includes('nvm/versions/node') || basePath.includes('fnm')) {
      try {
        if (fs.existsSync(basePath)) {
          const entries = fs.readdirSync(basePath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('v')) {
              const binPath = path.join(basePath, entry.name, 'bin');
              if (fs.existsSync(binPath)) {
                binPaths.push(binPath);
              }
            }
          }
        }
      } catch {
        // Ignore
      }
    } else if (fs.existsSync(basePath)) {
      binPaths.push(basePath);
    }
  }

  // Build PATH with node paths first
  const existingPath = process.env.PATH || '';
  const newPath = [...binPaths, existingPath].join(':');

  return {
    ...process.env,
    PATH: newPath,
    PORT: String(port),
    HOME: homeDir,
    // Ensure npm can find node
    NODE_PATH: path.dirname(path.dirname(getNpmPath())),
  };
}

export interface RunningProject {
  id: string;
  name: string;
  path: string;
  port: number;
  pid: number;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  startedAt: string;
  command: string;
  logs: string[];
  error?: string;
}

export interface ProjectStartError {
  error: string;
  code: string;
}

export type ProjectStartResult = RunningProject | ProjectStartError;

export function isProjectStartError(result: ProjectStartResult): result is ProjectStartError {
  return 'error' in result && 'code' in result;
}

interface ProjectConfig {
  name: string;
  path: string;
  startCommand: string;
  port: number;
}

// In-memory store of running projects
const runningProjects = new Map<string, RunningProject>();
const projectProcesses = new Map<string, ChildProcess>();

/**
 * Validate that a path is within the workspace directory
 */
function isPathWithinWorkspace(targetPath: string): boolean {
  const resolvedPath = path.resolve(targetPath);
  const resolvedWorkspace = path.resolve(PROJECTS_DIR);
  return resolvedPath.startsWith(resolvedWorkspace + path.sep) || resolvedPath === resolvedWorkspace;
}

/**
 * Validate command for dangerous patterns
 */
function isCommandSafe(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim();

  // Only allow npm, yarn, pnpm, npx commands at the start
  const allowedStarts = ['npm ', 'npm\t', 'yarn ', 'yarn\t', 'pnpm ', 'pnpm\t', 'npx ', 'npx\t'];
  const startsWithAllowed = allowedStarts.some(start =>
    trimmed.toLowerCase().startsWith(start.toLowerCase())
  );

  if (!startsWithAllowed) {
    return { safe: false, reason: 'Only npm, yarn, pnpm, and npx commands are allowed' };
  }

  // Check for shell operators that could allow command injection
  const shellOperators = ['&&', '||', ';', '|', '`', '$(', '>', '>>', '<'];
  for (const op of shellOperators) {
    if (trimmed.includes(op)) {
      return { safe: false, reason: `Command contains forbidden shell operator: ${op}` };
    }
  }

  // Check for sudo/su (could be part of script name, so check word boundaries)
  const sudoPattern = /\b(sudo|su)\b/i;
  if (sudoPattern.test(trimmed)) {
    return { safe: false, reason: 'Command cannot contain sudo or su' };
  }

  return { safe: true };
}

/**
 * Check if a port is already in use by another project
 */
function isPortInUse(port: number, excludeId?: string): boolean {
  for (const [id, project] of runningProjects) {
    if (project.port === port && project.status !== 'stopped' && id !== excludeId) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a port is actually available on the system
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Check if a project path is already running
 */
function isProjectRunning(projectPath: string, excludeId?: string): boolean {
  const resolvedPath = path.resolve(projectPath);
  for (const [id, project] of runningProjects) {
    if (path.resolve(project.path) === resolvedPath && project.status !== 'stopped' && id !== excludeId) {
      return true;
    }
  }
  return false;
}

/**
 * Clean up stopped projects from memory
 */
function cleanupStoppedProjects(): void {
  const toRemove: string[] = [];
  for (const [id, project] of runningProjects) {
    if (project.status === 'stopped') {
      toRemove.push(id);
    }
  }
  for (const id of toRemove) {
    runningProjects.delete(id);
    projectProcesses.delete(id);
    logger.debug({ id }, 'Cleaned up stopped project');
  }
}

// Load persisted projects on startup
function loadPersistedProjects(): void {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
      // Just load the configs, don't restart processes
      logger.info({ count: Object.keys(data).length }, 'Loaded project configs');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to load project configs');
  }
}

// Save project configs
function saveProjectConfigs(): void {
  try {
    const configs: Record<string, ProjectConfig> = {};
    runningProjects.forEach((project, id) => {
      if (project.status === 'running') {
        configs[id] = {
          name: project.name,
          path: project.path,
          startCommand: project.command,
          port: project.port,
        };
      }
    });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(configs, null, 2));
  } catch (error) {
    logger.error({ error }, 'Failed to save project configs');
  }
}

/**
 * Find available projects in the workspace
 */
export function discoverProjects(): Array<{ name: string; path: string; hasPackageJson: boolean; suggestedCommand: string; suggestedPort: number }> {
  const projects: Array<{ name: string; path: string; hasPackageJson: boolean; suggestedCommand: string; suggestedPort: number }> = [];

  try {
    logger.info({ PROJECTS_DIR, exists: fs.existsSync(PROJECTS_DIR) }, 'Discovering projects');

    if (!fs.existsSync(PROJECTS_DIR)) {
      logger.warn({ PROJECTS_DIR }, 'Projects directory does not exist');
      return projects;
    }

    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    logger.info({ entries: entries.map(e => e.name) }, 'Found workspace entries');

    let portOffset = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectPath = path.join(PROJECTS_DIR, entry.name);
      const packageJsonPath = path.join(projectPath, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          const scripts = packageJson.scripts || {};

          // Determine best start command
          let suggestedCommand = 'npm run dev';
          if (scripts.start && !scripts.dev) {
            suggestedCommand = 'npm start';
          } else if (scripts.dev) {
            suggestedCommand = 'npm run dev';
          }

          // Suggest a port based on project name hash
          const basePort = 3000;
          const portHash = entry.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
          const suggestedPort = basePort + (portHash % 1000);

          projects.push({
            name: entry.name,
            path: projectPath,
            hasPackageJson: true,
            suggestedCommand,
            suggestedPort,
          });

          logger.debug({ name: entry.name, command: suggestedCommand, port: suggestedPort }, 'Discovered project');
          portOffset++;
        } catch (parseError) {
          logger.warn({ entry: entry.name, error: parseError }, 'Failed to parse package.json');
        }
      }
    }

    logger.info({ count: projects.length }, 'Project discovery complete');
  } catch (error) {
    logger.error({ error }, 'Failed to discover projects');
  }

  return projects;
}

/**
 * Start a project
 */
export function startProject(
  projectPath: string,
  command: string,
  port: number,
  name?: string
): ProjectStartResult {
  // Validate path is within workspace
  if (!isPathWithinWorkspace(projectPath)) {
    return { error: 'Project path must be within the workspace directory', code: 'INVALID_PATH' };
  }

  // Validate command safety
  const cmdValidation = isCommandSafe(command);
  if (!cmdValidation.safe) {
    return { error: cmdValidation.reason || 'Invalid command', code: 'UNSAFE_COMMAND' };
  }

  // Check if path exists and has package.json
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { error: 'Project must have a package.json file', code: 'NO_PACKAGE_JSON' };
  }

  // Check for duplicate port
  if (isPortInUse(port)) {
    return { error: `Port ${port} is already in use by another project`, code: 'PORT_IN_USE' };
  }

  // Check if already running
  if (isProjectRunning(projectPath)) {
    return { error: 'This project is already running', code: 'ALREADY_RUNNING' };
  }

  // Check max limit
  const activeCount = Array.from(runningProjects.values()).filter(
    p => p.status !== 'stopped'
  ).length;
  if (activeCount >= MAX_RUNNING_PROJECTS) {
    return { error: `Maximum of ${MAX_RUNNING_PROJECTS} projects can run simultaneously`, code: 'MAX_LIMIT' };
  }

  // Clean up old stopped projects first
  cleanupStoppedProjects();

  const id = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const projectName = name || path.basename(projectPath);

  const project: RunningProject = {
    id,
    name: projectName,
    path: projectPath,
    port,
    pid: 0,
    status: 'starting',
    startedAt: new Date().toISOString(),
    command,
    logs: [],
  };

  runningProjects.set(id, project);

  try {
    // Build environment with proper PATH for node/npm
    const env = buildEnv(port);

    logger.info({ id, command, projectPath, port, envPath: env.PATH?.substring(0, 200) }, 'Starting project');

    // Use shell: true and pass the full command as a string
    // This ensures npm scripts work correctly
    const childProcess = spawn(command, [], {
      cwd: projectPath,
      env,
      shell: true,
      detached: false,
    });

    projectProcesses.set(id, childProcess);
    project.pid = childProcess.pid || 0;

    // Handle stdout
    childProcess.stdout?.on('data', (data) => {
      let log = data.toString();
      // Truncate very long log lines
      if (log.length > MAX_LOG_LENGTH) {
        log = log.substring(0, MAX_LOG_LENGTH) + '... [truncated]';
      }
      project.logs.push(`[${new Date().toISOString()}] ${log}`);
      // Keep only last 100 logs
      if (project.logs.length > 100) {
        project.logs.shift();
      }
      logger.debug({ id, log: log.trim() }, 'Project stdout');
    });

    // Handle stderr
    childProcess.stderr?.on('data', (data) => {
      let log = data.toString();
      if (log.length > MAX_LOG_LENGTH) {
        log = log.substring(0, MAX_LOG_LENGTH) + '... [truncated]';
      }
      project.logs.push(`[${new Date().toISOString()}] [stderr] ${log}`);
      if (project.logs.length > 100) {
        project.logs.shift();
      }
      logger.debug({ id, log: log.trim() }, 'Project stderr');
    });

    // Handle close
    childProcess.on('close', (code) => {
      logger.info({ id, code }, 'Project process closed');
      // Mark as error if non-zero exit code
      if (code !== 0 && code !== null) {
        project.status = 'error';
        project.error = `Process exited with code ${code}`;
      } else {
        project.status = 'stopped';
      }
      project.pid = 0;
      saveProjectConfigs();
    });

    // Handle error
    childProcess.on('error', (error) => {
      logger.error({ id, error }, 'Project process error');
      project.status = 'error';
      project.error = error.message;
    });

    // Give it a moment to start, then mark as running
    const startupTimer = setTimeout(() => {
      if (project.status === 'starting') {
        project.status = 'running';
        saveProjectConfigs();
      }
    }, 2000);

    // Clear timer if process exits before startup completes
    childProcess.on('close', () => {
      clearTimeout(startupTimer);
    });

  } catch (error) {
    logger.error({ error, id }, 'Failed to start project');
    project.status = 'error';
    project.error = error instanceof Error ? error.message : 'Failed to start';
  }

  return project;
}

/**
 * Stop a project
 */
export function stopProject(id: string): { success: boolean; error?: string } {
  const project = runningProjects.get(id);
  const proc = projectProcesses.get(id);

  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  if (project.status === 'stopped') {
    return { success: true }; // Already stopped
  }

  if (project.status === 'stopping') {
    return { success: false, error: 'Project is already stopping' };
  }

  project.status = 'stopping';

  if (proc && proc.pid) {
    try {
      // Send SIGTERM first for graceful shutdown
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      const forceKillTimer = setTimeout(() => {
        try {
          if (proc.pid) {
            process.kill(proc.pid, 'SIGKILL');
            logger.warn({ id, pid: proc.pid }, 'Force killed project process');
          }
        } catch {
          // Process already dead
        }
      }, 5000);

      // Clear timer when process exits
      proc.on('close', () => {
        clearTimeout(forceKillTimer);
      });

    } catch (error) {
      logger.error({ error, id }, 'Failed to kill process');
      // Try SIGKILL
      try {
        proc.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }
  }

  project.status = 'stopped';
  project.pid = 0;
  projectProcesses.delete(id);
  saveProjectConfigs();

  return { success: true };
}

/**
 * Delete a project from memory (must be stopped first)
 */
export function deleteProject(id: string): { success: boolean; error?: string } {
  const project = runningProjects.get(id);

  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  if (project.status !== 'stopped' && project.status !== 'error') {
    return { success: false, error: 'Project must be stopped before deleting' };
  }

  runningProjects.delete(id);
  projectProcesses.delete(id);
  logger.info({ id }, 'Deleted project from memory');

  return { success: true };
}

/**
 * Get all running projects
 */
export function getRunningProjects(): RunningProject[] {
  return Array.from(runningProjects.values());
}

/**
 * Get a specific project
 */
export function getProject(id: string): RunningProject | undefined {
  return runningProjects.get(id);
}

/**
 * Get project logs
 */
export function getProjectLogs(id: string, lines?: number): string[] {
  const project = runningProjects.get(id);
  if (!project) return [];

  if (lines && lines > 0) {
    return project.logs.slice(-lines);
  }
  return project.logs;
}

// Load persisted projects on module load
loadPersistedProjects();
