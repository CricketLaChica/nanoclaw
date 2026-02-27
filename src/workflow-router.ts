/**
 * Workflow Router
 * Handles workflow-related commands and status queries
 */

import { workflowEngine } from './workflow-engine.js';
import { getRegisteredGroup } from './db.js';
import { listWorkflows } from './workflow-parser.js';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';

/**
 * Format a date in the configured timezone for display
 */
function formatLocalDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Format workflow status for display in chat
 */
export function formatWorkflowStatus(status: any): string {
  if (!status) {
    return 'Workflow not found.';
  }

  const { run, steps, progress, currentStep } = status;

  let output = `**Workflow: ${run.workflow_id}**\n`;
  output += `Status: ${run.status}\n`;

  // Safely handle input truncation
  const input = run.input || '';
  output += `Input: ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}\n`;

  // Safely handle progress (may not exist for old runs)
  if (progress) {
    output += `Progress: ${progress.completed}/${progress.total} steps completed`;
    if (progress.failed > 0) {
      output += ` (${progress.failed} failed)`;
    }
    output += '\n';
  }

  if (currentStep) {
    output += `\nCurrently: ${currentStep.step_id} (${currentStep.agent_id})`;
  }

  // Show steps summary
  output += '\n\nSteps:\n';
  if (steps && steps.length > 0) {
    for (const step of steps) {
      const icon = step.status === 'completed' ? '✓' : step.status === 'running' ? '▶' : step.status === 'failed' ? '✗' : '○';
      output += `  ${icon} ${step.step_id} (${step.agent_id})`;
      if (step.status === 'failed' && step.error) {
        const error = String(step.error);
        output += ` - ${error.slice(0, 50)}${error.length > 50 ? '...' : ''}`;
      }
      output += '\n';
    }
  } else {
    output += '  No steps found\n';
  }

  return output;
}

/**
 * Format workflow list for display
 */
const MOTIVATIONAL_QUOTES = [
  '"The only way to do great work is to love what you do." — Steve Jobs',
  '"Success is not final, failure is not fatal: it is the courage to continue that counts." — Winston Churchill',
  '"Believe you can and you\'re halfway there." — Theodore Roosevelt',
  '"The future belongs to those who believe in the beauty of their dreams." — Eleanor Roosevelt',
  '"It is during our darkest moments that we must focus to see the light." — Aristotle',
  '"The best time to plant a tree was 20 years ago. The second best time is now." — Chinese Proverb',
  '"Your time is limited, don\'t waste it living someone else\'s life." — Steve Jobs',
  '"The only impossible journey is the one you never begin." — Tony Robbins',
  '"In the middle of every difficulty lies opportunity." — Albert Einstein',
  '"What lies behind us and what lies before us are tiny matters compared to what lies within us." — Ralph Waldo Emerson',
  '"Love is not about how many days, months, or years you\'ve been together. It\'s about how much you love each other every day." — Unknown',
  '"The greatest glory in living lies not in never falling, but in rising every time we fall." — Nelson Mandela',
  '"Life is what happens when you\'re busy making other plans." — John Lennon',
  '"The purpose of our lives is to be happy." — Dalai Lama',
  '"Work hard in silence, let your success be your noise." — Frank Ocean',
];

function getRandomQuote(): string {
  return MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
}

export function formatWorkflowList(workflows: any[]): string {
  if (workflows.length === 0) {
    return getRandomQuote();
  }

  let output = '**Workflow Runs:**\n\n';
  for (const wf of workflows) {
    const statusIcon = wf.status === 'completed' ? '✓' : wf.status === 'running' ? '▶' : wf.status === 'failed' ? '✗' : '○';
    output += `${statusIcon} **${wf.workflow_id}** - ${wf.status}\n`;
    output += `   ID: ${wf.id.slice(0, 8)}...\n`;
    output += `   Input: ${wf.input.slice(0, 60)}${wf.input.length > 60 ? '...' : ''}\n`;
    output += `   Progress: ${wf.progress}\n`;
    output += `   Created: ${formatLocalDateTime(wf.created_at)}\n\n`;
  }

  return output;
}

/**
 * List available workflow definitions
 */
export function listAvailableWorkflows(): string {
  const workflowIds = listWorkflows();

  if (workflowIds.length === 0) {
    return 'No workflow definitions found in workflows/ directory.';
  }

  let output = '**Available Workflows:**\n\n';
  for (const id of workflowIds) {
    output += `- ${id}\n`;
  }

  output += '\nStart a workflow: "Start <workflow-id> workflow to <task description>"';
  return output;
}

/**
 * Format workflow metrics for display
 */
export function formatWorkflowMetrics(metrics: any[]): string {
  if (!metrics || metrics.length === 0) {
    return 'No metrics available for this workflow.';
  }

  let output = '**Workflow Execution Metrics:**\n\n';
  let totalDuration = 0;

  for (const metric of metrics) {
    const durationSec = ((metric.duration_ms || 0) / 1000).toFixed(1);
    totalDuration += metric.duration_ms || 0;
    output += `${metric.step_id}:\n`;
    output += `  Duration: ${durationSec}s\n`;
    output += `  Container start: ${metric.container_start_ms ? ((metric.container_start_ms / 1000).toFixed(2) + 's') : 'N/A'}\n`;
    output += `  Agent execution: ${metric.agent_execution_ms ? ((metric.agent_execution_ms / 1000).toFixed(2) + 's') : 'N/A'}\n\n`;
  }

  output += `**Total: ${(totalDuration / 1000).toFixed(1)}s**`;
  return output;
}

/**
 * Format workflow artifacts for display
 */
export function formatArtifacts(artifacts: any[]): string {
  if (!artifacts || artifacts.length === 0) {
    return 'No artifacts found for this workflow.';
  }

  let output = '**Workflow Artifacts:**\n\n';

  // Group by artifact type
  const grouped: Record<string, any[]> = {};
  for (const artifact of artifacts) {
    if (!grouped[artifact.artifact_type]) {
      grouped[artifact.artifact_type] = [];
    }
    grouped[artifact.artifact_type].push(artifact);
  }

  const typeLabels: Record<string, string> = {
    pr: 'Pull Requests',
    file: 'Generated Files',
    test_result: 'Test Results',
    log: 'Logs',
    plan: 'Plans',
    code: 'Code Snippets',
  };

  for (const [type, items] of Object.entries(grouped)) {
    const label = typeLabels[type] || type.toUpperCase();
    output += `**${label}** (${items.length}):\n`;
    for (const item of items) {
      let metadata: Record<string, unknown> = {};
      if (item.metadata) {
        try {
          metadata = JSON.parse(item.metadata);
        } catch {
          // Invalid JSON, use empty object
        }
      }
      output += `  • ${item.path}`;
      if (metadata.description) {
        output += ` - ${metadata.description}`;
      }
      output += '\n';
    }
    output += '\n';
  }

  return output.trim();
}

/**
 * Format workflow templates for display
 */
export function formatTemplates(templates: any[]): string {
  if (!templates || templates.length === 0) {
    return 'No workflow templates available.';
  }

  let output = '**Workflow Templates:**\n\n';

  for (const template of templates) {
    output += `**${template.id}** - ${template.name}\n`;
    if (template.description) {
      output += `  ${template.description}\n`;
    }
    if (template.params && template.params.length > 0) {
      output += `  Parameters:\n`;
      for (const param of template.params) {
        const required = param.required ? ' (required)' : '';
        const defaultVal = param.default !== undefined ? ` [default: ${param.default}]` : '';
        output += `    • ${param.name}${required}: ${param.description || param.type}${defaultVal}\n`;
      }
    }
    output += '\n';
  }

  output += 'Use a template: "start <template-id> workflow with <param1>=<value1>, <param2>=<value2>"';
  return output.trim();
}

/**
 * Format workflow versions for display
 */
export function formatWorkflowVersions(versions: any[], workflowId?: string): string {
  if (!versions || versions.length === 0) {
    return workflowId ? `No versions found for workflow "${workflowId}".` : 'No workflow versions found.';
  }

  let output = `**Workflow Versions**${workflowId ? ` (${workflowId})` : ''}:\n\n`;

  for (const v of versions) {
    const versionLabel = v.version ? `v${v.version}` : 'base';
    output += `**${versionLabel}** - ${v.id}\n`;
    output += `  Name: ${v.name}\n`;
    if (v.description) {
      output += `  ${v.description}\n`;
    }
    if (v.created_at) {
      output += `  Modified: ${formatLocalDateTime(v.created_at)}\n`;
    }
    output += '\n';
  }

  output += `Use a specific version: "start ${workflowId || '<workflow-id>'}-v<version> workflow to <task>"`;
  return output.trim();
}

/**
 * Detect if a message is requesting a workflow action
 */
export function detectWorkflowIntent(message: string): {
  action: 'start' | 'status' | 'list' | 'pause' | 'resume' | 'cancel' | 'metrics' | 'inspect' | 'retry' | 'schedule' | 'artifacts' | 'templates' | 'versions' | null;
  workflowId?: string;
  runId?: string;
  task?: string;
  stepId?: string;
  userInput?: string; // For resuming paused workflows
  scheduleType?: 'cron' | 'interval' | 'once';
  scheduleValue?: string;
  artifactType?: string; // For filtering artifacts by type
} {
  const lower = message.toLowerCase().trim();

  // Start workflow - check first before more general patterns
  const startMatch = lower.match(/start\s+([\w-]+)\s+workflow\s+(?:to\s+)?(.+)/);
  if (startMatch) {
    return {
      action: 'start',
      workflowId: startMatch[1],
      task: startMatch[2],
    };
  }

  // Feature development shortcut
  const featureMatch = lower.match(/^(?:start\s+)?(?:a\s+)?(?:new\s+)?feature\s+(?:workflow\s+)?(.+)/);
  if (featureMatch) {
    return {
      action: 'start',
      workflowId: 'feature-dev',
      task: featureMatch[1],
    };
  }

  // Bug fix shortcut
  const bugMatch = lower.match(/^(?:start\s+)?(?:a\s+)?bug\s+fix\s+(?:workflow\s+)?(.+)/);
  if (bugMatch) {
    return {
      action: 'start',
      workflowId: 'bug-fix',
      task: bugMatch[1],
    };
  }

  // Status check - more specific than list
  const statusMatch = lower.match(/workflow\s+status|status\s+workflow|how'?s\s+the\s+workflow/);
  if (statusMatch) {
    // Try to extract run ID if provided (8 char hex)
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    return {
      action: 'status',
      runId: runIdMatch?.[0],
    };
  }

  // Pause workflow
  if (/pause\s+workflow\b/.test(lower)) {
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    return {
      action: 'pause',
      runId: runIdMatch?.[0],
    };
  }

  // Resume workflow with optional user input
  if (/resume\s+workflow\b/.test(lower)) {
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    // Capture everything after "resume workflow <id>" as user input
    const inputMatch = lower.match(/resume\s+workflow\s+[a-f0-9]{8}\s+(.+)/);
    return {
      action: 'resume',
      runId: runIdMatch?.[0],
      userInput: inputMatch?.[1],
    };
  }

  // Cancel workflow
  if (/cancel\s+workflow\b/.test(lower)) {
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    return {
      action: 'cancel',
      runId: runIdMatch?.[0],
    };
  }

  // Metrics/Stats
  if (/(?:workflow\s+)?(?:metrics|stats|timing|performance)\b/.test(lower)) {
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    return {
      action: 'metrics',
      runId: runIdMatch?.[0],
    };
  }

  // Inspect workflow step
  if (/inspect\s+workflow(?:\s+step)?\b/.test(lower)) {
    const workflowIdMatch = lower.match(/inspect\s+workflow\s+(\w+)/);
    const stepIdMatch = lower.match(/step\s+(\w+)/);
    return {
      action: 'inspect',
      workflowId: workflowIdMatch?.[1],
      stepId: stepIdMatch?.[1],
    };
  }

  // List workflows - most general, check last
  if (/^(list\s+)?workflows?\b/.test(lower) || /show\s+workflows\b/.test(lower)) {
    return { action: 'list' };
  }

  // Schedule workflow
  if (/schedule\s+workflow\b/.test(lower)) {
    const workflowIdMatch = lower.match(/workflow\s+(\w+(?:\-\w+)*)(?:\s+for\b|\s+at\b)?/);
    const cronMatch = lower.match(/(?:for|at)\s+(.+)/);

    // Parse schedule
    let scheduleType: 'cron' | 'interval' | 'once' = 'once';
    let scheduleValue = cronMatch?.[1]?.trim();

    if (scheduleValue?.match(/^\d+\s*(minute|hour|day|week|month)s?\s+(?:from\s+now|later)$/i)) {
      scheduleType = 'interval';
    } else if (scheduleValue?.match(/^.*?(?:daily|weekly|monthly|hourly)$/i)) {
      scheduleType = 'cron';
    }

    return {
      action: 'schedule',
      workflowId: workflowIdMatch?.[1],
      task: scheduleValue,
      scheduleType,
      scheduleValue,
    };
  }

  // Retry workflow step
  if (/retry\s+workflow(?:\s+step)?\b/.test(lower)) {
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    const stepIdMatch = lower.match(/step\s+(\w+)/);
    return {
      action: 'retry',
      runId: runIdMatch?.[0],
      stepId: stepIdMatch?.[1],
    };
  }

  // Show workflow artifacts
  if (/(?:show|list|view|get)\s+(?:workflow\s+)?artifacts?\b/.test(lower)) {
    const runIdMatch = lower.match(/\b[a-f0-9]{8}\b/);
    // Optional artifact type filter
    const typeMatch = lower.match(/(?:artifacts?)\s+(?:of\s+type\s+)?(pr|file|test_result|log|plan|code)/i);
    return {
      action: 'artifacts',
      runId: runIdMatch?.[0],
      artifactType: typeMatch?.[1],
    };
  }

  // List workflow templates
  if (/(?:list|show|view|available)?\s*(?:workflow\s+)?templates?\b/.test(lower)) {
    return { action: 'templates' };
  }

  // List workflow versions
  if (/(?:list|show|view)?\s*(?:workflow\s+)?versions?\b/.test(lower)) {
    // Extract workflow ID if provided
    const workflowMatch = lower.match(/versions?\s+(?:of\s+)?(?:workflow\s+)?(\w+(?:-\w+)*)(?:\s+versions?)?/);
    return {
      action: 'versions',
      workflowId: workflowMatch?.[1],
    };
  }

  // Available workflows (more specific patterns)
  if (/(?:^|\s)available\s+workflows?\b/.test(lower) || /(?:^|\s)what\s+workflows?\s+(?:are\s+)?(?:available|there)\b/.test(lower)) {
    return { action: 'list' };
  }

  return { action: null };
}

/**
 * Handle a workflow-related message
 */
export async function handleWorkflowMessage(
  message: string,
  groupFolder: string,
): Promise<{ response: string; shouldSend: boolean }> {
  const intent = detectWorkflowIntent(message);

  if (!intent.action) {
    return { response: '', shouldSend: false };
  }

  try {
    switch (intent.action) {
      case 'list': {
        const workflows = listAvailableWorkflows();
        return { response: workflows, shouldSend: true };
      }

      case 'start': {
        if (!intent.workflowId) {
          return {
            response: 'To start a workflow: "Start <workflow-id> workflow to <task>"',
            shouldSend: true,
          };
        }

        if (!intent.task || intent.task.trim().length === 0) {
          return {
            response: 'Please provide a task description: "Start <workflow-id> workflow to <your task>"',
            shouldSend: true,
          };
        }

        const runId = await workflowEngine.startRun(intent.workflowId, groupFolder, intent.task);

        if (!runId) {
          return {
            response: `Failed to start workflow "${intent.workflowId}". Possible reasons: workflow doesn't exist, failed validation, or circular dependency detected.`,
            shouldSend: true,
          };
        }

        return {
          response: `Started ${intent.workflowId} workflow (ID: ${runId.slice(0, 8)}...). Type "workflow status" to check progress.`,
          shouldSend: true,
        };
      }

      case 'status': {
        // Construct JID from folder name
        const chatJid = `${groupFolder}@nanoclaw.local`;
        const group = getRegisteredGroup(chatJid);
        if (!group) {
          return { response: 'Group not found.', shouldSend: true };
        }

        if (intent.runId) {
          // Get specific run by ID prefix
          const runs = workflowEngine.listWorkflows(group.folder);
          const run = runs.find((r) => r.id.startsWith(intent.runId!));

          if (!run) {
            return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
          }

          const status = workflowEngine.getStatus(run.id);
          return {
            response: formatWorkflowStatus(status),
            shouldSend: true,
          };
        } else {
          // Get most recent run for this group
          const runs = workflowEngine.listWorkflows(group.folder);
          if (runs.length === 0) {
            return {
              response: getRandomQuote(),
              shouldSend: true,
            };
          }

          const status = workflowEngine.getStatus(runs[0].id);
          return {
            response: formatWorkflowStatus(status),
            shouldSend: true,
          };
        }
      }

      case 'pause': {
        if (!intent.runId) {
          return { response: 'Provide workflow ID to pause. Use "workflow status" to find it.', shouldSend: true };
        }

        const chatJid = `${groupFolder}@nanoclaw.local`;
        const group = getRegisteredGroup(chatJid);
        if (!group) {
          return { response: 'Group not found.', shouldSend: true };
        }

        const runs = workflowEngine.listWorkflows(group.folder);
        const run = runs.find((r) => r.id.startsWith(intent.runId));

        if (!run) {
          return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
        }

        workflowEngine.pauseRun(run.id);
        return { response: `Workflow ${run.id.slice(0, 8)}... paused. Resume with "resume workflow ${run.id.slice(0, 8)}"`, shouldSend: true };
      }

      case 'resume': {
        if (!intent.runId) {
          return { response: 'Provide workflow ID to resume. Use "workflow status" to find it.', shouldSend: true };
        }

        const chatJid = `${groupFolder}@nanoclaw.local`;
        const group = getRegisteredGroup(chatJid);
        if (!group) {
          return { response: 'Group not found.', shouldSend: true };
        }

        const runs = workflowEngine.listWorkflows(group.folder);
        const run = runs.find((r) => r.id.startsWith(intent.runId));

        if (!run) {
          return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
        }

        // Check if workflow is paused
        const { getWorkflowRun } = await import('./workflow-db.js');
        const runDetails = getWorkflowRun(run.id);
        if (!runDetails) {
          return { response: `Workflow run details not found.`, shouldSend: true };
        }

        if (runDetails.status !== 'paused') {
          return { response: `Workflow is not paused (current status: ${runDetails.status}). Use "workflow status" for details.`, shouldSend: true };
        }

        // Get user input from message or prompt for it
        let userInput = intent.userInput || '';
        if (!userInput) {
          return {
            response: `Workflow ${run.id.slice(0, 8)}... is paused and waiting for input.\nTo resume, provide your input: "resume workflow ${run.id.slice(0, 8)} <your input>"`,
            shouldSend: true,
          };
        }

        const result = await workflowEngine.resumeWorkflow(run.id, userInput);
        return { response: result.message, shouldSend: true };
      }

      case 'cancel': {
        if (!intent.runId) {
          return { response: 'Provide workflow ID to cancel. Use "workflow status" to find it.', shouldSend: true };
        }

        const chatJid = `${groupFolder}@nanoclaw.local`;
        const group = getRegisteredGroup(chatJid);
        if (!group) {
          return { response: 'Group not found.', shouldSend: true };
        }

        const runs = workflowEngine.listWorkflows(group.folder);
        const run = runs.find((r) => r.id.startsWith(intent.runId));

        if (!run) {
          return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
        }

        workflowEngine.cancelRun(run.id);
        return { response: `Workflow ${run.id.slice(0, 8)}... cancelled.`, shouldSend: true };
      }

      case 'metrics': {
        const { getWorkflowMetrics } = await import('./workflow-db.js');

        if (intent.runId) {
          // Get metrics for specific run
          const chatJid = `${groupFolder}@nanoclaw.local`;
          const group = getRegisteredGroup(chatJid);
          if (!group) {
            return { response: 'Group not found.', shouldSend: true };
          }

          const runs = workflowEngine.listWorkflows(group.folder);
          const run = runs.find((r) => r.id.startsWith(intent.runId));

          if (!run) {
            return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
          }

          const metrics = getWorkflowMetrics(run.id);
          return {
            response: formatWorkflowMetrics(metrics),
            shouldSend: true,
          };
        } else {
          // Get metrics for most recent run
          const chatJid = `${groupFolder}@nanoclaw.local`;
          const group = getRegisteredGroup(chatJid);
          if (!group) {
            return { response: 'Group not found.', shouldSend: true };
          }

          const runs = workflowEngine.listWorkflows(group.folder);
          if (runs.length === 0) {
            return {
              response: getRandomQuote(),
              shouldSend: true,
            };
          }

          const metrics = getWorkflowMetrics(runs[0].id);
          return {
            response: formatWorkflowMetrics(metrics),
            shouldSend: true,
          };
        }
      }

      case 'inspect': {
        const { loadWorkflow } = await import('./workflow-parser.js');

        if (!intent.workflowId) {
          return {
            response: 'Usage: "inspect workflow <workflow-id> step <step-id>"',
            shouldSend: true,
          };
        }

        const workflow = loadWorkflow(intent.workflowId);
        if (!workflow) {
          return {
            response: `Workflow "${intent.workflowId}" not found.`,
            shouldSend: true,
          };
        }

        if (intent.stepId) {
          // Inspect specific step
          const step = workflow.steps.find((s) => s.id === intent.stepId);
          if (!step) {
            return {
              response: `Step "${intent.stepId}" not found in workflow "${intent.workflowId}".`,
              shouldSend: true,
            };
          }

          const agent = workflow.agents.find((a) => a.id === step.agent);
          let output = `**Step: ${step.id}**\n`;
          output += `Agent: ${agent?.name || step.agent} (${step.agent})\n`;
          output += `Input Template:\n${step.input.slice(0, 500)}${step.input.length > 500 ? '...' : ''}\n`;
          if (step.depends_on && step.depends_on.length > 0) {
            output += `Dependencies: ${step.depends_on.join(', ')}\n`;
          }
          output += `Max Retries: ${step.max_retries || 3}\n`;
          output += `On Failure: ${step.on_failure || 'retry'}\n`;
          if (step.timeout) {
            output += `Timeout: ${step.timeout}ms\n`;
          }
          if (step.expects) {
            output += `Expects Output: "${step.expects}"\n`;
          }
          return { response: output, shouldSend: true };
        } else {
          // List all steps
          let output = `**Workflow: ${workflow.name} (${workflow.id})**\n\nSteps:\n`;
          for (const step of workflow.steps) {
            const agent = workflow.agents.find((a) => a.id === step.agent);
            output += `- ${step.id} (${agent?.name || step.agent})\n`;
          }
          output += `\nUsage: "inspect workflow ${intent.workflowId} step <step-id>"`;
          return { response: output, shouldSend: true };
        }
      }

      case 'retry': {
        if (!intent.runId) {
          return {
            response: 'Provide workflow ID to retry. Use "workflow status" to find it.',
            shouldSend: true,
          };
        }

        if (!intent.stepId) {
          return {
            response: 'Provide step ID to retry. Usage: "retry workflow <id> step <step-id>"',
            shouldSend: true,
          };
        }

        const chatJid = `${groupFolder}@nanoclaw.local`;
        const group = getRegisteredGroup(chatJid);
        if (!group) {
          return { response: 'Group not found.', shouldSend: true };
        }

        const runs = workflowEngine.listWorkflows(group.folder);
        const run = runs.find((r) => r.id.startsWith(intent.runId));

        if (!run) {
          return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
        }

        try {
          await workflowEngine.retryStep(run.id, intent.stepId);
          return {
            response: `Retrying step ${intent.stepId} in workflow ${run.id.slice(0, 8)}...`,
            shouldSend: true,
          };
        } catch (err) {
          return {
            response: `Error retrying step: ${err instanceof Error ? err.message : String(err)}`,
            shouldSend: true,
          };
        }
      }

      case 'schedule': {
        const { createTask } = await import('./db.js');
        const { randomUUID } = await import('crypto');

        if (!intent.workflowId || !intent.scheduleValue) {
          return {
            response: 'Usage: "schedule workflow <workflow-id> for <schedule>"\nExamples:\n- schedule workflow feature-dev for 9pm tomorrow\n- schedule workflow bug-fix for daily at 10am\n- schedule workflow feature-dev in 1 hour',
            shouldSend: true,
          };
        }

        // Verify workflow exists
        const { loadWorkflow } = await import('./workflow-parser.js');
        const workflow = loadWorkflow(intent.workflowId);
        if (!workflow) {
          return {
            response: `Workflow "${intent.workflowId}" not found.`,
            shouldSend: true,
          };
        }

        // Parse and calculate next_run
        const { CronExpressionParser } = await import('cron-parser');
        let nextRun: string;
        let scheduleType: 'cron' | 'interval' | 'once' = intent.scheduleType || 'once';

        try {
          if (intent.scheduleType === 'cron' || !intent.scheduleType) {
            // Try to parse as cron expression
            if (intent.scheduleValue?.match(/^(daily|weekly|monthly|hourly)$/i)) {
              // Simple aliases
              const aliases: Record<string, string> = {
                daily: '0 9 * * *',
                weekly: '0 9 * * 0',
                monthly: '0 9 1 * *',
                hourly: '0 * * * *',
              };
              const cronExpr = aliases[intent.scheduleValue.toLowerCase()] || intent.scheduleValue;
              const interval = CronExpressionParser.parse(cronExpr, { tz: 'America/New_York' });
              const next = interval.next();
              if (!next) throw new Error('Invalid cron expression');
              nextRun = next.toISOString()!;
              scheduleType = 'cron';
            } else if (intent.scheduleValue?.match(/^\d+\s+(second|minute|hour|day|week|month)s?\s+from\s+now$/i)) {
              // Interval: "5 minutes from now"
              const match = intent.scheduleValue.match(/^(\d+)\s+(second|minute|hour|day|week|month)s?\s+from\s+now$/i);
              if (match) {
                const value = parseInt(match[1], 10);
                const unit = match[2].toLowerCase();
                const unitToMs: Record<string, number> = {
                  second: 1000,
                  minute: 60000,
                  hour: 3600000,
                  day: 86400000,
                  week: 604800000,
                  month: 2592000000, // 30 days
                };
                const ms = value * (unitToMs[unit] || 60000);
                nextRun = new Date(Date.now() + ms).toISOString();
                scheduleType = 'interval';
              } else {
                throw new Error('Invalid interval format');
              }
            } else if (intent.scheduleValue) {
              // Default: parse as cron
              const interval = CronExpressionParser.parse(intent.scheduleValue, { tz: 'America/New_York' });
              const next = interval.next();
              if (!next) throw new Error('Invalid cron expression');
              nextRun = next.toISOString()!;
              scheduleType = 'cron';
            } else {
              throw new Error('Schedule value is required for cron scheduling');
            }
          } else if (intent.scheduleValue) {
            // Interval - try parsing as milliseconds first, then as interval format
            const ms = parseInt(intent.scheduleValue, 10);
            if (isNaN(ms) || ms <= 0) {
              throw new Error('Invalid interval value: must be a positive number');
            }
            nextRun = new Date(Date.now() + ms).toISOString();
          } else {
            throw new Error('Schedule value is required');
          }
        } catch (err) {
          return {
            response: `Invalid schedule: "${intent.scheduleValue}". Error: ${err instanceof Error ? err.message : String(err)}`,
            shouldSend: true,
          };
        }

        // Create scheduled task
        const chatJid = `${groupFolder}@nanoclaw.local`;
        createTask({
          id: randomUUID(),
          group_folder: groupFolder,
          chat_jid: chatJid,
          prompt: `workflow:${intent.workflowId}:${intent.task || ''}`,
          schedule_type: scheduleType,
          schedule_value: intent.scheduleValue || 'once',
          context_mode: 'isolated',
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          task_type: 'workflow',
          workflow_id: intent.workflowId,
        });

        return {
          response: `Scheduled ${intent.workflowId} workflow for "${intent.scheduleValue}"\nNext run: ${formatLocalDateTime(nextRun)}\n\nType "list tasks" to see all scheduled workflows.`,
          shouldSend: true,
        };
      }

      case 'artifacts': {
        const { getWorkflowArtifacts } = await import('./workflow-db.js');
        const { listWorkflowRuns } = await import('./workflow-db.js');

        let artifacts: any[] = [];

        if (intent.runId) {
          // Get artifacts for specific workflow run
          const runs = listWorkflowRuns();
          const run = runs.find((r) => r.id.startsWith(intent.runId!));
          if (!run) {
            return { response: `Workflow run ${intent.runId}... not found.`, shouldSend: true };
          }
          artifacts = getWorkflowArtifacts(run.id);

          // Filter by type if specified
          if (intent.artifactType) {
            artifacts = artifacts.filter((a) => a.artifact_type === intent.artifactType);
          }
        } else {
          // No run ID specified - get recent artifacts from this group
          const runs = listWorkflowRuns(groupFolder);
          for (const run of runs.slice(0, 5)) { // Last 5 runs
            const runArtifacts = getWorkflowArtifacts(run.id);
            if (intent.artifactType) {
              runArtifacts.filter((a) => a.artifact_type === intent.artifactType);
            }
            artifacts.push(...runArtifacts.map((a: any) => ({ ...a, run_id: run.id })));
          }
        }

        return {
          response: formatArtifacts(artifacts),
          shouldSend: true,
        };
      }

      case 'templates': {
        const { listTemplates } = await import('./workflow-parser.js');
        const templates = listTemplates();
        return {
          response: formatTemplates(templates),
          shouldSend: true,
        };
      }

      case 'versions': {
        const { listWorkflowVersions } = await import('./workflow-parser.js');
        // If workflowId is provided, list its versions; otherwise list versions for all workflows
        if (intent.workflowId) {
          const versions = listWorkflowVersions(intent.workflowId);
          return {
            response: formatWorkflowVersions(versions, intent.workflowId),
            shouldSend: true,
          };
        } else {
          // List all workflows and their versions
          const { listWorkflows } = await import('./workflow-parser.js');
          const workflowIds = listWorkflows();
          let output = '**All Workflow Versions:**\n\n';
          for (const id of workflowIds) {
            const versions = listWorkflowVersions(id);
            if (versions.length > 1) { // Only show workflows with multiple versions
              output += formatWorkflowVersions(versions, id) + '\n\n';
            }
          }
          return {
            response: output.trim() || 'No workflows with multiple versions found.',
            shouldSend: true,
          };
        }
      }

      default:
        return { response: '', shouldSend: false };
    }
  } catch (err) {
    logger.error({ message, error: err }, 'Workflow handler error');
    return { response: `Error: ${err instanceof Error ? err.message : String(err)}`, shouldSend: true };
  }
}
