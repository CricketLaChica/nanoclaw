/**
 * Workflow Parser
 * Loads and validates workflow definitions from YAML files
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { logger } from './logger.js';
import { WorkflowDefinition, WorkflowAgent, WorkflowStep } from './workflow-types.js';

const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');

/**
 * Validation error details
 */
export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Result of workflow validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Load a workflow definition by ID
 */
export function loadWorkflow(id: string): WorkflowDefinition | null {
  const workflowPath = path.join(WORKFLOWS_DIR, id, 'workflow.yaml');

  if (!fs.existsSync(workflowPath)) {
    logger.error({ workflowId: id, path: workflowPath }, 'Workflow file not found');
    return null;
  }

  try {
    const content = fs.readFileSync(workflowPath, 'utf-8');
    // Use FAILSAFE_SCHEMA to prevent code execution
    const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA }) as any;

    return parsed;
  } catch (err) {
    logger.error({ workflowId: id, error: err }, 'Failed to parse workflow YAML');
    return null;
  }
}

/**
 * List all available workflow IDs
 */
export function listWorkflows(): string[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(WORKFLOWS_DIR, name, 'workflow.yaml')));
}

/**
 * List all workflow templates (workflows with is_template: true)
 */
export function listTemplates(): Array<{ id: string; name: string; description?: string; params?: any[] }> {
  const workflowIds = listWorkflows();
  const templates: Array<{ id: string; name: string; description?: string; params?: any[] }> = [];

  for (const id of workflowIds) {
    const workflow = loadWorkflow(id);
    if (workflow && workflow.is_template) {
      templates.push({
        id,
        name: workflow.name,
        description: workflow.description,
        params: workflow.template_params,
      });
    }
  }

  return templates;
}

/**
 * List all versions of a workflow
 * Versions are identified by matching workflow IDs with suffix patterns like "-v1", "-v2", etc.
 * or by the version field in the workflow definition.
 */
export function listWorkflowVersions(workflowId: string): Array<{ id: string; version?: string; name: string; description?: string; created_at?: string }> {
  const workflowIds = listWorkflows();
  const versions: Array<{ id: string; version?: string; name: string; description?: string; created_at?: string }> = [];

  // Get the base workflow ID (without version suffix)
  const baseId = workflowId.replace(/-v\d+$/, '');

  // Find all matching workflows (base ID and any versioned variants)
  for (const id of workflowIds) {
    const idMatches = id === baseId || id.startsWith(`${baseId}-v`);
    if (idMatches) {
      const workflow = loadWorkflow(id);
      if (workflow) {
        // Get file stats for created_at time
        const workflowPath = path.join(WORKFLOWS_DIR, id, 'workflow.yaml');
        const stats = fs.existsSync(workflowPath) ? fs.statSync(workflowPath) : undefined;

        versions.push({
          id,
          version: workflow.version || extractVersionFromId(id, baseId),
          name: workflow.name,
          description: workflow.description,
          created_at: stats?.mtime.toISOString(),
        });
      }
    }
  }

  // Sort by version (descending) - assume v1, v2, etc. or semver
  versions.sort((a, b) => {
    const vA = a.version || '0';
    const vB = b.version || '0';
    return vB.localeCompare(vA, undefined, { numeric: true });
  });

  return versions;
}

/**
 * Extract version from workflow ID (e.g., "my-workflow-v2" -> "v2")
 */
function extractVersionFromId(id: string, baseId: string): string | undefined {
  if (id === baseId) {
    return undefined; // Base version (no suffix)
  }
  const match = id.replace(baseId, '').match(/-v(\d+)$/);
  return match ? match[1] : undefined;
}

/**
 * Validate a workflow definition
 */
export function validateWorkflow(workflow: WorkflowDefinition): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // Validate required fields
  if (!workflow.id) {
    errors.push({ path: 'id', message: 'Workflow ID is required' });
  }
  if (!workflow.name) {
    errors.push({ path: 'name', message: 'Workflow name is required' });
  }

  // Validate agents
  if (!workflow.agents || workflow.agents.length === 0) {
    errors.push({ path: 'agents', message: 'At least one agent is required' });
  } else {
    const agentIds = new Set<string>();

    for (let i = 0; i < workflow.agents.length; i++) {
      const agent = workflow.agents[i];
      const prefix = `agents[${i}]`;

      if (!agent.id) {
        errors.push({ path: `${prefix}.id`, message: 'Agent ID is required' });
      } else if (agentIds.has(agent.id)) {
        errors.push({ path: `${prefix}.id`, message: `Duplicate agent ID: ${agent.id}` });
      } else {
        agentIds.add(agent.id);
      }

      if (!agent.name) {
        errors.push({ path: `${prefix}.name`, message: 'Agent name is required' });
      }

      if (!agent.persona) {
        errors.push({ path: `${prefix}.persona`, message: 'Agent persona is required' });
      }

      if (!agent.workspace) {
        errors.push({ path: `${prefix}.workspace`, message: 'Agent workspace is required' });
      } else if (!agent.workspace.mount) {
        errors.push({ path: `${prefix}.workspace.mount`, message: 'Workspace mount is required' });
      }
    }
  }

  // Validate steps
  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push({ path: 'steps', message: 'At least one step is required' });
  } else {
    const stepIds = new Set<string>();
    const agentIds = new Set(workflow.agents.map((a) => a.id));

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const prefix = `steps[${i}]`;

      if (!step.id) {
        errors.push({ path: `${prefix}.id`, message: 'Step ID is required' });
      } else if (stepIds.has(step.id)) {
        errors.push({ path: `${prefix}.id`, message: `Duplicate step ID: ${step.id}` });
      } else {
        stepIds.add(step.id);
      }

      if (!step.agent) {
        errors.push({ path: `${prefix}.agent`, message: 'Step agent reference is required' });
      } else if (!agentIds.has(step.agent)) {
        errors.push({
          path: `${prefix}.agent`,
          message: `Agent "${step.agent}" not found in workflow agents`,
        });
      }

      if (!step.input) {
        errors.push({ path: `${prefix}.input`, message: 'Step input template is required' });
      }

      // Validate dependencies
      if (step.depends_on && step.depends_on.length > 0) {
        for (const dep of step.depends_on) {
          if (!stepIds.has(dep) && !workflow.steps.some((s) => s.id === dep)) {
            errors.push({
              path: `${prefix}.depends_on`,
              message: `Dependency "${dep}" not found in steps`,
            });
          }
        }
      }

      // Validate max_retries
      if (step.max_retries !== undefined && (step.max_retries < 0 || step.max_retries > 10)) {
        warnings.push({
          path: `${prefix}.max_retries`,
          message: 'max_retries should be between 0 and 10',
        });
      }

      // Validate on_failure
      if (step.on_failure && !['retry', 'escalate', 'skip'].includes(step.on_failure)) {
        errors.push({
          path: `${prefix}.on_failure`,
          message: `on_failure must be one of: retry, escalate, skip`,
        });
      }
    }
  }

  // Validate workflow timeout
  if (workflow.timeout !== undefined) {
    if (typeof workflow.timeout !== 'number' || workflow.timeout < 1000) {
      errors.push({
        path: 'timeout',
        message: 'Workflow timeout must be at least 1000ms (1 second)',
      });
    } else if (workflow.timeout > 3600000) {
      warnings.push({
        path: 'timeout',
        message: 'Workflow timeout exceeds 1 hour - consider breaking into smaller workflows',
      });
    }
  }

  // Validate step timeouts
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const prefix = `steps[${i}]`;

    if (step.timeout !== undefined) {
      if (typeof step.timeout !== 'number' || step.timeout < 1000) {
        errors.push({
          path: `${prefix}.timeout`,
          message: 'Step timeout must be at least 1000ms (1 second)',
        });
      } else if (step.timeout > 1800000) {
        warnings.push({
          path: `${prefix}.timeout`,
          message: 'Step timeout exceeds 30 minutes',
        });
      }
    }
  }

  // Check for circular dependencies
  const circularDeps = detectCircularDependencies(workflow.steps);
  if (circularDeps.length > 0) {
    errors.push({
      path: 'steps',
      message: `Circular dependencies detected: ${circularDeps.join(' -> ')}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detect circular dependencies in workflow steps
 */
function detectCircularDependencies(steps: WorkflowStep[]): string[] {
  const stepMap = new Map<string, string[]>();
  for (const step of steps) {
    stepMap.set(step.id, step.depends_on || []);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycle: string[] = [];

  function dfs(stepId: string, path: string[]): boolean {
    visited.add(stepId);
    recStack.add(stepId);
    path.push(stepId);

    const deps = stepMap.get(stepId) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (dfs(dep, path)) {
          return true;
        }
      } else if (recStack.has(dep)) {
        // Found cycle - extract it from path
        const depIndex = path.indexOf(dep);
        cycle.push(...path.slice(depIndex), dep);
        return true;
      }
    }

    recStack.delete(stepId);
    path.pop();
    return false;
  }

  for (const stepId of stepMap.keys()) {
    if (!visited.has(stepId)) {
      if (dfs(stepId, [])) {
        return cycle;
      }
    }
  }

  return [];
}

/**
 * Get agent persona file content
 */
export function getAgentPersona(workflowId: string, agentId: string): string | null {
  const personaPath = path.join(WORKFLOWS_DIR, workflowId, 'agents', `${agentId}.md`);

  if (!fs.existsSync(personaPath)) {
    logger.warn({ workflowId, agentId, path: personaPath }, 'Agent persona file not found');
    return null;
  }

  try {
    return fs.readFileSync(personaPath, 'utf-8');
  } catch (err) {
    logger.error({ workflowId, agentId, error: err }, 'Failed to read agent persona file');
    return null;
  }
}

/**
 * Interpolate variables in a template string
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;

  // Replace {{variable}} patterns
  for (const [key, value] of Object.entries(variables)) {
    // Escape special regex characters in variable name
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, 'g');
    result = result.replace(regex, value || '');
  }

  // Handle nested variables like {{plan.story_1}}
  const nestedRegex = /\{\{(\w+)\.(\w+)\}\}/g;
  result = result.replace(nestedRegex, (match, obj, prop) => {
    const objVar = variables[obj];
    if (objVar) {
      try {
        const parsed = JSON.parse(objVar);
        if (parsed && typeof parsed === 'object' && prop in parsed) {
          return String(parsed[prop]);
        }
        return match;
      } catch {
        return match;
      }
    }
    return match;
  });

  return result;
}

/**
 * Extract variables from agent output
 * Parses patterns like STORY: title -> extracts "title"
 */
export function extractVariables(output: string, expects: string): Record<string, string> {
  const variables: Record<string, string> = {};

  // Try to match the expected pattern
  if (expects.includes(':')) {
    const [key, ...rest] = expects.split(':');
    const pattern = rest.join(':').trim();

    // Look for "KEY: value" pattern in output
    const regex = new RegExp(`${key}\\s*:\\s*(.+?)(?:\\n|$)`, 'i');
    const match = output.match(regex);

    if (match) {
      variables[key.toLowerCase()] = match[1].trim();
    }
  }

  // Extract common patterns
  const statusMatch = output.match(/STATUS:\s*(\w+)/i);
  if (statusMatch) {
    variables.status = statusMatch[1];
  }

  return variables;
}
