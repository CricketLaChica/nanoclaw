/**
 * Workflow Database Operations
 * CRUD operations for workflow runs, steps, and artifacts
 */

import { v4 as uuidv4 } from 'uuid';

import { db } from './db.js';
import { logger } from './logger.js';
import {
  WorkflowArtifact,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepExecution,
  StepStatus,
  WorkflowSummary,
} from './workflow-types.js';

// --- Workflow Runs ---

/**
 * Create a new workflow run
 */
export function createWorkflowRun(
  workflowId: string,
  groupId: string,
  input: string,
): string {
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO workflow_runs (id, workflow_id, group_id, status, input, context, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, workflowId, groupId, 'pending', input, '{}', now, now);

  logger.info({ workflowRunId: id, workflowId, groupId }, 'Workflow run created');
  return id;
}

/**
 * Get a workflow run by ID
 */
export function getWorkflowRun(id: string): WorkflowRun | undefined {
  const row = db
    .prepare('SELECT * FROM workflow_runs WHERE id = ?')
    .get(id) as
    | {
        id: string;
        workflow_id: string;
        group_id: string;
        status: WorkflowRunStatus;
        input: string;
        context: string;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
      }
    | undefined;

  if (!row) return undefined;

  return {
    id: row.id,
    workflow_id: row.workflow_id,
    group_id: row.group_id,
    status: row.status,
    input: row.input,
    context: row.context,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || undefined,
  };
}

/**
 * Update workflow run status
 */
export function updateWorkflowRunStatus(
  id: string,
  status: WorkflowRunStatus,
  context?: string,
): void {
  // Validate status is one of the allowed values
  const validStatuses: WorkflowRunStatus[] = ['pending', 'running', 'paused', 'completed', 'failed', 'escalated'];
  if (!validStatuses.includes(status)) {
    logger.error({ workflowRunId: id, status }, 'Invalid workflow run status');
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }

  const now = new Date().toISOString();
  const completedAt = status === 'completed' || status === 'failed' || status === 'escalated' ? now : null;

  db.prepare(
    `
    UPDATE workflow_runs
    SET status = ?, context = COALESCE(?, context), updated_at = ?, completed_at = ?
    WHERE id = ?
  `,
  ).run(status, context, now, completedAt, id);

  logger.debug({ workflowRunId: id, status }, 'Workflow run status updated');
}

/**
 * Update workflow run context
 */
export function updateWorkflowRunContext(id: string, context: string): void {
  // Validate that context is valid JSON before updating
  try {
    JSON.parse(context);
  } catch (err) {
    logger.error({ workflowRunId: id, error: err }, 'Invalid context JSON, not updating');
    throw new Error('Context must be valid JSON');
  }

  const now = new Date().toISOString();

  db.prepare(
    `UPDATE workflow_runs SET context = ?, updated_at = ? WHERE id = ?`,
  ).run(context, now, id);
}

/**
 * List workflow runs for a group
 */
export function listWorkflowRuns(groupId?: string): WorkflowSummary[] {
  let sql = `
    SELECT
      wr.id,
      wr.workflow_id,
      wr.group_id,
      wr.status,
      wr.input,
      wr.created_at,
      wr.updated_at,
      COUNT(ws.id) as total_steps,
      SUM(CASE WHEN ws.status = 'completed' THEN 1 ELSE 0 END) as completed_steps
    FROM workflow_runs wr
    LEFT JOIN workflow_steps ws ON wr.id = ws.run_id
  `;

  const params: unknown[] = [];

  if (groupId) {
    sql += ' WHERE wr.group_id = ?';
    params.push(groupId);
  }

  sql += ' GROUP BY wr.id ORDER BY wr.created_at DESC';

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    workflow_id: string;
    group_id: string;
    status: WorkflowRunStatus;
    input: string;
    created_at: string;
    updated_at: string;
    total_steps: number;
    completed_steps: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    workflow_id: row.workflow_id,
    group_id: row.group_id,
    status: row.status,
    input: row.input,
    created_at: row.created_at,
    updated_at: row.updated_at,
    progress: `${row.completed_steps}/${row.total_steps} steps completed`,
  }));
}

/**
 * Get active (running or paused) workflow runs
 */
export function getActiveWorkflowRuns(): WorkflowRun[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM workflow_runs
      WHERE status IN ('running', 'paused')
      ORDER BY created_at ASC
    `,
    )
    .all() as Array<{
      id: string;
      workflow_id: string;
      group_id: string;
      status: WorkflowRunStatus;
      input: string;
      context: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    workflow_id: row.workflow_id,
    group_id: row.group_id,
    status: row.status,
    input: row.input,
    context: row.context,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || undefined,
  }));
}

/**
 * Delete a workflow run (cascade deletes steps and artifacts)
 */
export function deleteWorkflowRun(id: string): void {
  db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id);
  logger.info({ workflowRunId: id }, 'Workflow run deleted');
}

// --- Workflow Steps ---

/**
 * Create workflow step executions for a run
 */
export function createWorkflowSteps(
  runId: string,
  steps: Array<{ id: string; agent: string }>,
): void {
  const now = new Date().toISOString();

  const insert = db.prepare(
    `
    INSERT INTO workflow_steps (id, run_id, step_id, agent_id, status, input, retries, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `,
  );

  for (const step of steps) {
    const stepId = uuidv4();
    insert.run(stepId, runId, step.id, step.agent, 'pending', '', 0, now);
  }

  logger.debug({ runId, count: steps.length }, 'Workflow steps created');
}

/**
 * Get all steps for a workflow run
 */
export function getWorkflowSteps(runId: string): WorkflowStepExecution[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM workflow_steps
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(runId) as Array<{
      id: string;
      run_id: string;
      step_id: string;
      agent_id: string;
      status: StepStatus;
      input: string;
      output: string | null;
      error: string | null;
      retries: number;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    run_id: row.run_id,
    step_id: row.step_id,
    agent_id: row.agent_id,
    status: row.status,
    input: row.input,
    output: row.output || undefined,
    error: row.error || undefined,
    retries: row.retries,
    started_at: row.started_at || undefined,
    completed_at: row.completed_at || undefined,
  }));
}

/**
 * Get a specific workflow step execution
 */
export function getWorkflowStep(id: string): WorkflowStepExecution | undefined {
  const row = db
    .prepare('SELECT * FROM workflow_steps WHERE id = ?')
    .get(id) as
    | {
        id: string;
        run_id: string;
        step_id: string;
        agent_id: string;
        status: StepStatus;
        input: string;
        output: string | null;
        error: string | null;
        retries: number;
        started_at: string | null;
        completed_at: string | null;
      }
    | undefined;

  if (!row) return undefined;

  return {
    id: row.id,
    run_id: row.run_id,
    step_id: row.step_id,
    agent_id: row.agent_id,
    status: row.status,
    input: row.input,
    output: row.output || undefined,
    error: row.error || undefined,
    retries: row.retries,
    started_at: row.started_at || undefined,
    completed_at: row.completed_at || undefined,
  };
}

/**
 * Update workflow step status
 */
export function updateWorkflowStepStatus(
  id: string,
  status: StepStatus,
  output?: string,
  error?: string,
): void {
  const now = new Date().toISOString();
  const startedAt = status === 'running' ? now : undefined;
  const completedAt = status === 'completed' || status === 'failed' || status === 'skipped' ? now : undefined;

  db.prepare(
    `
    UPDATE workflow_steps
    SET status = ?, output = COALESCE(?, output), error = COALESCE(?, error),
        started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at)
    WHERE id = ?
  `,
  ).run(status, output || null, error || null, startedAt, completedAt, id);

  logger.debug({ stepExecutionId: id, status }, 'Workflow step status updated');
}

/**
 * Increment step retry count
 */
export function incrementStepRetries(id: string): void {
  db.prepare(
    `UPDATE workflow_steps SET retries = retries + 1, status = 'pending' WHERE id = ?`,
  ).run(id);
}

/**
 * Get pending steps for a workflow run
 */
export function getPendingSteps(runId: string): WorkflowStepExecution[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM workflow_steps
      WHERE run_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `,
    )
    .all(runId) as WorkflowStepExecution[];

  return rows;
}

/**
 * Get next step to execute (respecting dependencies)
 * Returns the first pending step whose dependencies are all completed
 */
export function getNextRunnableStep(
  runId: string,
  stepDependencies: Map<string, string[]>,
): WorkflowStepExecution | undefined {
  const steps = getWorkflowSteps(runId);
  const completedSteps = new Set(steps.filter((s) => s.status === 'completed').map((s) => s.step_id));

  for (const step of steps) {
    if (step.status !== 'pending') continue;

    const dependencies = stepDependencies.get(step.step_id) || [];
    const depsMet = dependencies.every((dep) => completedSteps.has(dep));

    if (depsMet) {
      return step;
    }
  }

  return undefined;
}

// --- Workflow Artifacts ---

/**
 * Create a workflow artifact
 */
export function createWorkflowArtifact(
  runId: string,
  stepId: string | undefined,
  artifactType: string,
  path: string,
  metadata: Record<string, unknown>,
): string {
  const id = uuidv4();
  const now = new Date().toISOString();

  let metadataJson: string;
  try {
    // Use replacer function to handle circular references and unstringifiable values
    const seen = new WeakSet();
    metadataJson = JSON.stringify(metadata, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      // Handle functions and other unstringifiable values
      if (typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
      }
      return value;
    });
  } catch (err) {
    logger.error({ artifactId: id, runId, error: err }, 'Failed to stringify artifact metadata, using empty object');
    metadataJson = '{}';
  }

  db.prepare(
    `
    INSERT INTO workflow_artifacts (id, run_id, step_id, artifact_type, path, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, runId, stepId || null, artifactType, path, metadataJson, now);

  logger.debug({ artifactId: id, runId, artifactType, path }, 'Workflow artifact created');
  return id;
}

/**
 * Get artifacts for a workflow run
 */
export function getWorkflowArtifacts(runId: string, stepId?: string): WorkflowArtifact[] {
  let sql = 'SELECT * FROM workflow_artifacts WHERE run_id = ?';
  const params: unknown[] = [runId];

  if (stepId) {
    sql += ' AND step_id = ?';
    params.push(stepId);
  }

  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    run_id: string;
    step_id: string | null;
    artifact_type: string;
    path: string;
    metadata: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    run_id: row.run_id,
    step_id: row.step_id || undefined,
    artifact_type: row.artifact_type as any,
    path: row.path,
    metadata: row.metadata,
    created_at: row.created_at,
  }));
}

/**
 * Get workflow progress summary
 */
export function getWorkflowProgress(runId: string): {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
} {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM workflow_steps
      WHERE run_id = ?
    `,
    )
    .get(runId) as {
      total: number;
      completed: number;
      failed: number;
      running: number;
      pending: number;
    };

  return {
    total: row.total,
    completed: row.completed || 0,
    failed: row.failed || 0,
    running: row.running || 0,
    pending: row.pending || 0,
  };
}

// --- Workflow Metrics ---

/**
 * Create a workflow metric entry
 */
export function createWorkflowMetric(
  runId: string,
  stepId: string,
  durationMs: number,
  containerStartMs: number,
  agentExecutionMs: number,
): string {
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO workflow_metrics (id, run_id, step_id, duration_ms, container_start_ms, agent_execution_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, runId, stepId, durationMs, containerStartMs, agentExecutionMs, now);

  return id;
}

/**
 * Get workflow metrics for a run
 */
export function getWorkflowMetrics(runId: string): Array<{
  id: string;
  run_id: string;
  step_id: string;
  duration_ms: number;
  container_start_ms: number;
  agent_execution_ms: number;
  created_at: string;
}> {
  return db
    .prepare('SELECT * FROM workflow_metrics WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId) as any[];
}

/**
 * Get aggregate workflow metrics for a run
 */
export function getWorkflowMetricsSummary(runId: string): {
  totalSteps: number;
  totalDurationMs: number;
  avgContainerStartMs: number;
  avgAgentExecutionMs: number;
} | null {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) as total_steps,
        SUM(duration_ms) as total_duration_ms,
        AVG(container_start_ms) as avg_container_start_ms,
        AVG(agent_execution_ms) as avg_agent_execution_ms
      FROM workflow_metrics
      WHERE run_id = ?
    `,
    )
    .get(runId) as any;

  if (!row) return null;

  return {
    totalSteps: row.total_steps || 0,
    totalDurationMs: row.total_duration_ms || 0,
    avgContainerStartMs: row.avg_container_start_ms || 0,
    avgAgentExecutionMs: row.avg_agent_execution_ms || 0,
  };
}

/**
 * Get comprehensive workflow status for a run
 */
export function getWorkflowStatus(runId: string): {
  run: WorkflowRun;
  steps: WorkflowStepExecution[];
  currentStep?: WorkflowStepExecution;
  progress: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  };
} | undefined {
  const run = getWorkflowRun(runId);
  if (!run) {
    return undefined;
  }

  const steps = getWorkflowSteps(runId);
  const progress = getWorkflowProgress(runId);

  // Find current step (first running or pending step)
  const currentStep = steps.find(
    (s) => s.status === 'running' || (s.status === 'pending' && !progress.completed)
  );

  return {
    run,
    steps,
    currentStep,
    progress: {
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed,
      running: progress.running,
      pending: progress.pending,
    },
  };
}
