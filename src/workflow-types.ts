/**
 * Workflow System Types
 * Multi-agent workflow orchestration for NanoClaw
 */

/**
 * Workflow definition loaded from YAML
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version?: string;
  timeout?: number; // Overall workflow timeout in milliseconds
  agents: WorkflowAgent[];
  steps: WorkflowStep[];
  // Template metadata
  is_template?: boolean; // If true, this workflow can be used as a template
  template_params?: TemplateParam[]; // Parameters that can be customized when instantiating
}

/**
 * Template parameter definition
 */
export interface TemplateParam {
  name: string;
  description?: string;
  type: 'text' | 'number' | 'select' | 'boolean';
  default?: string | number | boolean;
  required?: boolean;
  options?: string[]; // For 'select' type
}

/**
 * Condition for conditional step execution
 */
export interface StepCondition {
  variable: string; // Variable path, e.g., "previousSteps.planner.output" or "task.result"
  operator: 'equals' | 'not_equals' | 'contains' | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than' | 'exists' | 'not_exists';
  value?: string | number | boolean; // Expected value (not used for exists/not_exists)
}

/**
 * Agent definition in a workflow
 */
export interface WorkflowAgent {
  id: string;
  name: string;
  description?: string;
  persona: string;
  workspace: AgentWorkspace;
  timeout?: number; // Default timeout for this agent's containers
}

/**
 * Workspace configuration for an agent
 */
export interface AgentWorkspace {
  mount: string; // What to mount (e.g., "." for full project)
  files: Record<string, string>; // Files to create: { "CLAUDE.md": "agents/planner.md" }
}

/**
 * Step definition in a workflow
 */
export interface WorkflowStep {
  id: string;
  agent: string; // Agent ID
  input: string; // Input prompt template (supports {{variable}} interpolation)
  expects?: string; // Expected output marker (e.g., "STATUS: done")
  depends_on?: string[]; // Step IDs that must complete first
  max_retries?: number; // Default: 3
  on_failure?: 'retry' | 'escalate' | 'skip';
  timeout?: number; // Override agent timeout
  parallel_group?: string; // Steps with same group can run in parallel
  pause_for_input?: boolean; // If true, pause workflow after this step and wait for user input
  input_prompt?: string; // Prompt to show user when asking for input
  condition?: StepCondition; // Condition that must be true for step to execute
  sub_workflow?: string; // If set, execute this sub-workflow instead of an agent
}

/**
 * Workflow run state in database
 */
export interface WorkflowRun {
  id: string;
  workflow_id: string;
  group_id: string;
  status: WorkflowRunStatus;
  input: string;
  context: string; // JSON string with accumulated state
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'escalated';

/**
 * Workflow step execution state
 */
export interface WorkflowStepExecution {
  id: string;
  run_id: string;
  step_id: string;
  agent_id: string;
  status: StepStatus;
  input: string;
  output?: string;
  error?: string;
  retries: number;
  started_at?: string;
  completed_at?: string;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

/**
 * Workflow artifact (generated files, PRs, test results, etc.)
 */
export interface WorkflowArtifact {
  id: string;
  run_id: string;
  step_id?: string;
  artifact_type: ArtifactType;
  path: string;
  metadata: string; // JSON string with type-specific data
  created_at: string;
}

export type ArtifactType = 'pr' | 'file' | 'test_result' | 'log' | 'plan' | 'code';

/**
 * Container input for workflow step execution
 */
export interface WorkflowStepInput {
  stepId: string;
  agentId: string;
  input: string;
  runId: string;
  groupId: string;
  workspaceContext: WorkspaceContext;
}

/**
 * Context passed to workflow step containers
 */
export interface WorkspaceContext {
  workflowRunId: string;
  previousOutputs: Record<string, string>; // step_id -> output
  variables: Record<string, string>; // Extracted variables from outputs
  artifacts: WorkflowArtifact[];
  userInput?: string; // User input when resuming from pause
}

/**
 * Result of a workflow step execution
 */
export interface WorkflowStepResult {
  success: boolean;
  output?: string;
  error?: string;
  artifacts?: WorkflowArtifact[];
  shouldRetry?: boolean;
  shouldEscalate?: boolean;
}

/**
 * Workflow status summary
 */
export interface WorkflowStatus {
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
}

/**
 * Workflow summary for listing
 */
export interface WorkflowSummary {
  id: string;
  workflow_id: string;
  group_id: string;
  status: WorkflowRunStatus;
  input: string;
  created_at: string;
  updated_at: string;
  progress: string; // e.g., "3/7 steps completed"
}
