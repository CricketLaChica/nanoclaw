/**
 * Workflow Engine
 * Core orchestration engine for multi-agent workflows
 */

import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { getRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { getAgentPersona, interpolateTemplate, loadWorkflow, validateWorkflow } from './workflow-parser.js';
import { saveMemory } from './memory.js';
import { broadcastEvent } from './websocket.js';
import {
  createWorkflowArtifact,
  createWorkflowMetric,
  createWorkflowRun,
  createWorkflowSteps,
  deleteWorkflowRun,
  getActiveWorkflowRuns,
  getNextRunnableStep,
  getWorkflowArtifacts,
  getWorkflowProgress,
  getWorkflowRun,
  getWorkflowSteps,
  updateWorkflowRunContext,
  updateWorkflowRunStatus,
  updateWorkflowStepStatus,
  incrementStepRetries,
  listWorkflowRuns,
} from './workflow-db.js';
import {
  WorkspaceContext,
  WorkflowDefinition,
  WorkflowRunStatus,
  WorkflowStepExecution,
  WorkflowStepInput,
  WorkflowStepResult,
  StepStatus,
  ArtifactType,
} from './workflow-types.js';

const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');
const GROUPS_DIR = path.join(process.cwd(), 'groups');

/**
 * Workflow Engine - orchestrates multi-agent workflows
 */
export class WorkflowEngine {
  private running = new Map<string, boolean>(); // runId -> isRunning flag
  private activeContainers = new Map<string, any[]>(); // runId -> array of container processes
  private workflowStartTimes = new Map<string, number>(); // runId -> start timestamp
  private workflowCallStack = new Map<string, string[]>(); // runId -> array of workflow IDs in call stack

  /**
   * Load and validate a workflow definition
   */
  loadWorkflow(id: string): WorkflowDefinition | null {
    const workflow = loadWorkflow(id);
    if (!workflow) {
      logger.error({ workflowId: id }, 'Workflow not found');
      return null;
    }

    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      logger.error({ workflowId: id, errors: validation.errors }, 'Workflow validation failed');
      return null;
    }

    if (validation.warnings.length > 0) {
      logger.warn({ workflowId: id, warnings: validation.warnings }, 'Workflow validation warnings');
    }

    return workflow;
  }

  /**
   * Start a new workflow run
   */
  async startRun(workflowId: string, groupId: string, input: string, parentCallStack: string[] = []): Promise<string | null> {
    const workflow = this.loadWorkflow(workflowId);
    if (!workflow) {
      return null;
    }

    // Check for circular dependency (infinite recursion)
    if (parentCallStack.includes(workflowId)) {
      logger.error({ workflowId, callStack: [...parentCallStack, workflowId] }, 'Circular workflow dependency detected');
      return null;
    }

    // Create workflow run in database
    const runId = createWorkflowRun(workflowId, groupId, input);

    // Initialize call stack for this run
    this.workflowCallStack.set(runId, [...parentCallStack, workflowId]);

    // Create step executions
    const steps = workflow.steps.map((s) => ({ id: s.id, agent: s.agent }));
    createWorkflowSteps(runId, steps);

    // Mark as running
    this.running.set(runId, true);
    updateWorkflowRunStatus(runId, 'running');

    logger.info({ workflowRunId: runId, workflowId, groupId, input }, 'Workflow run started');

    // Broadcast workflow started event
    broadcastEvent('workflow.started', {
      runId,
      workflowId,
      groupId,
      input: input.slice(0, 200),
      timestamp: new Date().toISOString(),
    });

    // Store workflow start time for timeout checking
    this.workflowStartTimes.set(runId, Date.now());

    // Start executing steps (non-blocking)
    this.executeSteps(runId, workflow).catch((err) => {
      logger.error({ workflowRunId: runId, error: err }, 'Workflow execution error');
      updateWorkflowRunStatus(runId, 'failed');
      this.running.delete(runId);
      this.workflowStartTimes.delete(runId);
      this.workflowCallStack.delete(runId);
    });

    return runId;
  }

  /**
   * Instantiate a workflow from a template with custom parameters
   */
  instantiateTemplate(
    templateId: string,
    params: Record<string, string | number | boolean>,
    customId?: string
  ): WorkflowDefinition | null {
    const template = this.loadWorkflow(templateId);
    if (!template) {
      logger.error({ templateId }, 'Template not found');
      return null;
    }

    if (!template.is_template) {
      logger.error({ templateId }, 'Workflow is not a template');
      return null;
    }

    // Validate that all required parameters are provided
    if (template.template_params) {
      const missingParams: string[] = [];
      for (const param of template.template_params) {
        if (param.required && !(param.name in params)) {
          missingParams.push(param.name);
        }
      }
      if (missingParams.length > 0) {
        logger.error({ templateId, missingParams }, 'Missing required template parameters');
        return null;
      }
    }

    // Create a new workflow from the template
    const instantiated: WorkflowDefinition = {
      ...template,
      id: customId || `${templateId}-${Date.now()}`,
      is_template: false, // The instance is not a template
      template_params: undefined,
    };

    // Substitute parameters in agent personas and step inputs
    const paramVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      paramVars[key] = String(value);
    }

    // Update agents with substituted parameters
    instantiated.agents = template.agents.map((agent) => ({
      ...agent,
      persona: this.substituteParams(agent.persona, paramVars),
    }));

    // Update steps with substituted parameters
    instantiated.steps = template.steps.map((step) => ({
      ...step,
      input: this.substituteParams(step.input, paramVars),
      // Also substitute in input_prompt if it exists
      ...(step.input_prompt ? { input_prompt: this.substituteParams(step.input_prompt, paramVars) } : {}),
    }));

    // Check for any unreplaced placeholders (missing optional parameters)
    const unreplaced = this.findUnreplacedPlaceholders(instantiated);
    if (unreplaced.length > 0) {
      logger.warn({ templateId, unreplaced }, 'Template has unreplaced placeholders after instantiation');
    }

    logger.info({ templateId, customId: instantiated.id, params }, 'Template instantiated');

    return instantiated;
  }

  /**
   * Find any unreplaced {{placeholder}} patterns in workflow
   */
  private findUnreplacedPlaceholders(workflow: WorkflowDefinition): string[] {
    const unreplaced: string[] = [];
    const placeholderRegex = /\{\{(\w+)\}\}/g;

    for (const agent of workflow.agents) {
      let match;
      while ((match = placeholderRegex.exec(agent.persona)) !== null) {
        if (!unreplaced.includes(match[1])) {
          unreplaced.push(match[1]);
        }
      }
    }

    for (const step of workflow.steps) {
      let match;
      while ((match = placeholderRegex.exec(step.input)) !== null) {
        if (!unreplaced.includes(match[1])) {
          unreplaced.push(match[1]);
        }
      }
      if (step.input_prompt) {
        while ((match = placeholderRegex.exec(step.input_prompt)) !== null) {
          if (!unreplaced.includes(match[1])) {
            unreplaced.push(match[1]);
          }
        }
      }
    }

    return unreplaced;
  }

  /**
   * Substitute template parameters in a string
   * Parameters are referenced as {{param_name}}
   */
  private substituteParams(template: string, params: Record<string, string>): string {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
      // Escape special regex characters in parameter name
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g');
      result = result.replace(regex, value);
    }
    return result;
  }

  /**
   * Execute workflow steps (main loop)
   */
  private async executeSteps(runId: string, workflow: WorkflowDefinition): Promise<void> {
    const run = getWorkflowRun(runId);
    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    // Convert folder to full JID
    const chatJid = `${run.group_id}@nanoclaw.local`;
    const group = getRegisteredGroup(chatJid);
    if (!group) {
      throw new Error(`Group ${run.group_id} not found`);
    }

    // Build step dependency map
    const stepDependencies = new Map<string, string[]>();
    for (const step of workflow.steps) {
      stepDependencies.set(step.id, step.depends_on || []);
    }

    // Execute steps until all are complete or failed
    while (this.running.get(runId)) {
      // Check for workflow timeout
      if (workflow.timeout) {
        const startTime = this.workflowStartTimes.get(runId) || 0;
        const elapsed = Date.now() - startTime;
        if (elapsed > workflow.timeout) {
          updateWorkflowRunStatus(runId, 'failed');
          this.running.delete(runId);
          this.workflowStartTimes.delete(runId);
          this.workflowCallStack.delete(runId);
          logger.warn({ workflowRunId: runId, timeout: workflow.timeout, elapsed }, 'Workflow timeout exceeded');
          break;
        }
      }

      // Get ALL runnable steps (supports parallel groups and conditions)
      const runnableSteps = this.getAllRunnableSteps(runId, stepDependencies, workflow.steps, workflow);

      if (runnableSteps.length === 0) {
        // Check if we're done (all steps completed or failed)
        const steps = getWorkflowSteps(runId);
        const allDone = steps.every(
          (s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped',
        );

        if (allDone) {
          const hasFailures = steps.some((s) => s.status === 'failed');
          const finalStatus: WorkflowRunStatus = hasFailures ? 'failed' : 'completed';
          updateWorkflowRunStatus(runId, finalStatus);
          this.running.delete(runId);
          this.workflowStartTimes.delete(runId);
          this.workflowCallStack.delete(runId);
          logger.info({ workflowRunId: runId, status: finalStatus }, 'Workflow run completed');

          // Broadcast workflow completed event
          broadcastEvent('workflow.completed', {
            runId,
            workflowId: workflow.id,
            status: finalStatus,
            progress: getWorkflowProgress(runId),
            timestamp: new Date().toISOString(),
          });

          // Save completion summary to memory
          this.saveWorkflowMemory(runId, workflow.id, run.input, finalStatus, steps);
        } else {
          // No runnable steps but not all done - might be waiting for dependencies
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        continue;
      }

      // Group runnable steps by parallel_group
      const parallelGroups = this.groupStepsByParallel(runnableSteps, workflow);

      // Execute each parallel group
      for (const [groupName, stepsInGroup] of parallelGroups.entries()) {
        if (stepsInGroup.length === 1) {
          // Single step - execute normally
          const stepExec = stepsInGroup[0];
          const stepDef = workflow.steps.find((s) => s.id === stepExec.step_id);
          if (!stepDef) {
            logger.error({ stepId: stepExec.step_id }, 'Step definition not found');
            updateWorkflowStepStatus(stepExec.id, 'failed', undefined, 'Step definition not found');
            continue;
          }
          try {
            await this.executeStep(runId, stepExec, stepDef, workflow, group);
          } catch (err: any) {
            if (err?.message === 'WORKFLOW_PAUSED') {
              // Workflow paused for user input - exit gracefully
              logger.info({ workflowRunId: runId, stepId: err.stepId }, 'Workflow execution paused');
              return;
            }
            throw err; // Re-throw other errors
          }
        } else {
          // Multiple steps - execute in parallel
          await Promise.all(
            stepsInGroup.map(async (stepExec) => {
              const stepDef = workflow.steps.find((s) => s.id === stepExec.step_id);
              if (!stepDef) {
                logger.error({ stepId: stepExec.step_id }, 'Step definition not found');
                updateWorkflowStepStatus(stepExec.id, 'failed', undefined, 'Step definition not found');
                return;
              }
              try {
                await this.executeStep(runId, stepExec, stepDef, workflow, group);
              } catch (err: any) {
                if (err?.message === 'WORKFLOW_PAUSED') {
                  // Workflow paused for user input - log and return
                  logger.info({ workflowRunId: runId, stepId: err.stepId }, 'Workflow execution paused (parallel group)');
                  return;
                }
                throw err; // Re-throw other errors
              }
            })
          );
          logger.info({ workflowRunId: runId, group: groupName, count: stepsInGroup.length }, 'Parallel group completed');
        }
      }
    }
  }

  /**
   * Execute a single workflow step
   */
  private async executeStep(
    runId: string,
    stepExec: WorkflowStepExecution,
    stepDef: any,
    workflow: WorkflowDefinition,
    group: any,
  ): Promise<void> {
    const run = getWorkflowRun(runId);
    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    const stepStartTime = Date.now();

    // Get previous outputs for context
    const steps = getWorkflowSteps(runId);
    const previousOutputs: Record<string, string> = {};
    const artifacts = getWorkflowArtifacts(runId);

    for (const s of steps) {
      if (s.status === 'completed' && s.output) {
        previousOutputs[s.step_id] = s.output;
      }
    }

    // Build workspace context
    let runContext: Record<string, unknown> = {};
    try {
      runContext = JSON.parse(run.context);
    } catch {
      runContext = {};
    }
    const workspaceContext: WorkspaceContext = {
      workflowRunId: runId,
      previousOutputs,
      variables: {
        task: run.input,
        ...this.extractVariablesFromOutputs(previousOutputs),
      },
      artifacts,
      userInput: runContext.userInput as string | undefined,
    };

    // Interpolate input template
    const input = interpolateTemplate(stepDef.input, workspaceContext.variables);

    // Mark step as running
    updateWorkflowStepStatus(stepExec.id, 'running');

    // Check if this is a sub-workflow step
    if (stepDef.sub_workflow) {
      logger.info(
        { workflowRunId: runId, stepId: stepDef.id, subWorkflow: stepDef.sub_workflow },
        'Executing sub-workflow'
      );

      try {
        // Get the current call stack for this run
        const callStack = this.workflowCallStack.get(runId) || [];

        // Start the sub-workflow with current call stack to detect recursion
        const subWorkflowRunId = await this.startRun(
          stepDef.sub_workflow,
          group.folder,
          input, // Use the interpolated input as the sub-workflow's task
          callStack // Pass call stack to detect circular dependencies
        );

        if (!subWorkflowRunId) {
          throw new Error(`Failed to start sub-workflow ${stepDef.sub_workflow} (possibly circular dependency)`);
        }

        // Wait for sub-workflow to complete
        const { getWorkflowStatus } = await import('./workflow-db.js');
        let status = await getWorkflowStatus(subWorkflowRunId);

        while (status && (status.run.status === 'pending' || status.run.status === 'running')) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          status = await getWorkflowStatus(subWorkflowRunId);
        }

        const finalStatus = status?.run.status || 'unknown';
        const completed = finalStatus === 'completed';

        // Get sub-workflow output
        const subWorkflowSteps = getWorkflowSteps(subWorkflowRunId);
        const lastStep = subWorkflowSteps[subWorkflowSteps.length - 1];
        const subWorkflowOutput = lastStep?.output || `Sub-workflow ${finalStatus}`;

        if (completed) {
          updateWorkflowStepStatus(stepExec.id, 'completed', subWorkflowOutput);
          logger.info(
            { workflowRunId: runId, stepId: stepDef.id, subWorkflowRunId, output: subWorkflowOutput?.slice(0, 200) },
            'Sub-workflow completed'
          );
        } else {
          updateWorkflowStepStatus(stepExec.id, 'failed', undefined, `Sub-workflow ${finalStatus}`);
          throw new Error(`Sub-workflow ${stepDef.sub_workflow} ${finalStatus}`);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        updateWorkflowStepStatus(stepExec.id, 'failed', undefined, error);
        throw err;
      }
      return; // Skip normal agent execution
    }

    // Get agent persona
    const agent = workflow.agents.find((a) => a.id === stepDef.agent);
    if (!agent) {
      throw new Error(`Agent ${stepDef.agent} not found in workflow`);
    }

    // Prepare agent input
    const agentInput: WorkflowStepInput = {
      stepId: stepDef.id,
      agentId: agent.id,
      input,
      runId,
      groupId: group.folder,
      workspaceContext,
    };

    logger.info(
      { workflowRunId: runId, stepId: stepDef.id, agent: agent.id, input: input.slice(0, 200) },
      'Executing workflow step',
    );

    // Broadcast step started event
    broadcastEvent('workflow.step_started', {
      runId,
      stepId: stepDef.id,
      agentId: agent.id,
      progress: getWorkflowProgress(runId),
      timestamp: new Date().toISOString(),
    });

    try {
      // Execute agent in container
      const result = await this.executeAgentInContainer(stepExec, agentInput, agent, stepDef, group, workflow);

      if (result.success) {
        updateWorkflowStepStatus(stepExec.id, 'completed', result.output);

        // Record execution metric
        const stepDurationMs = Date.now() - stepStartTime;
        if (result.timing) {
          createWorkflowMetric(
            runId,
            stepDef.id,
            stepDurationMs,
            result.timing.containerStartMs,
            result.timing.agentExecutionMs,
          );
        }

        // Save artifacts
        if (result.artifacts) {
          const validArtifactTypes: ArtifactType[] = ['pr', 'file', 'test_result', 'log', 'plan', 'code'];
          for (const artifact of result.artifacts) {
            // Validate artifact type
            if (!validArtifactTypes.includes(artifact.artifact_type as ArtifactType)) {
              logger.warn({ artifactType: artifact.artifact_type }, 'Invalid artifact type, skipping');
              continue;
            }

            // Sanitize artifact path to prevent path traversal
            let sanitizedPath = artifact.path;
            if (sanitizedPath) {
              // Remove any path traversal attempts
              sanitizedPath = sanitizedPath.replace(/\.\./g, '').replace(/\/+/g, '/').replace(/^\/+/, '');
              // Limit path length
              if (sanitizedPath.length > 1000) {
                logger.warn({ path: sanitizedPath, length: sanitizedPath.length }, 'Artifact path too long, truncating');
                sanitizedPath = sanitizedPath.substring(0, 1000);
              }
            }

            let parsedMetadata: Record<string, unknown>;
            try {
              parsedMetadata = artifact.metadata ? JSON.parse(artifact.metadata) : {};
            } catch (err) {
              logger.warn({ artifact, error: err }, 'Invalid artifact metadata, using empty object');
              parsedMetadata = {};
            }
            createWorkflowArtifact(
              runId,
              stepExec.id,
              artifact.artifact_type,
              sanitizedPath || '',
              parsedMetadata,
            );
          }
        }

        // Update run context with new variables (with error handling for corrupted context)
        let existingContext: Record<string, unknown>;
        try {
          existingContext = JSON.parse(run.context);
        } catch {
          existingContext = {};
        }
        const newContext = { ...existingContext, ...workspaceContext.variables };
        updateWorkflowRunContext(runId, JSON.stringify(newContext));

        logger.info(
          { workflowRunId: runId, stepId: stepDef.id, output: result.output?.slice(0, 200), duration: stepDurationMs },
          'Workflow step completed',
        );

        // Broadcast step completed event
        broadcastEvent('workflow.step_completed', {
          runId,
          stepId: stepDef.id,
          agentId: agent.id,
          duration: stepDurationMs,
          progress: getWorkflowProgress(runId),
          timestamp: new Date().toISOString(),
        });

        // Check if this step pauses for user input
        if (stepDef.pause_for_input) {
          updateWorkflowStepStatus(stepExec.id, 'paused');
          updateWorkflowRunStatus(runId, 'paused');
          this.running.delete(runId);

          // Close all active containers for this workflow
          this.closeAllContainers(runId);

          logger.info(
            { workflowRunId: runId, stepId: stepDef.id, inputPrompt: stepDef.input_prompt || 'Please provide input' },
            'Workflow paused waiting for user input'
          );

          // Create a special pause result object that will be caught by executeSteps
          const pauseError = new Error('WORKFLOW_PAUSED') as any;
          pauseError.paused = true;
          pauseError.stepId = stepDef.id;
          pauseError.inputPrompt = stepDef.input_prompt || 'Please provide input to continue the workflow';
          pauseError.output = result.output;
          throw pauseError;
        }
      } else if (result.shouldRetry) {
        incrementStepRetries(stepExec.id);
        logger.warn({ workflowRunId: runId, stepId: stepDef.id, error: result.error }, 'Step will be retried');
      } else if (result.shouldEscalate) {
        updateWorkflowStepStatus(stepExec.id, 'failed', undefined, result.error);
        updateWorkflowRunStatus(runId, 'escalated');
        this.running.delete(runId);
        logger.error({ workflowRunId: runId, stepId: stepDef.id, error: result.error }, 'Step escalated to user');
      } else {
        updateWorkflowStepStatus(stepExec.id, 'failed', undefined, result.error);
        logger.error({ workflowRunId: runId, stepId: stepDef.id, error: result.error }, 'Step failed');
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      updateWorkflowStepStatus(stepExec.id, 'failed', undefined, error);
      logger.error({ workflowRunId: runId, stepId: stepDef.id, error }, 'Step execution error');
    }
  }

  /**
   * Execute an agent in a container for a workflow step
   */
  private async executeAgentInContainer(
    stepExec: WorkflowStepExecution,
    agentInput: WorkflowStepInput,
    agent: any,
    stepDef: any,
    group: any,
    workflow: WorkflowDefinition,
  ): Promise<WorkflowStepResult & { timing?: { containerStartMs: number; agentExecutionMs: number } }> {
    const containerStartTime = Date.now();
    const groupDir = path.join(GROUPS_DIR, group.folder);

    // Create workspace directory for this workflow run
    const workflowRunDir = path.join(groupDir, 'workflow-output', agentInput.runId);
    fs.mkdirSync(workflowRunDir, { recursive: true });

    // Prepare agent's AGENTS.md file
    const agentsDir = path.join(workflowRunDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const personaPath = path.join(agentsDir, 'AGENTS.md');
    const personaContent = getAgentPersona(workflow.id, agent.id) || agent.persona;
    fs.writeFileSync(personaPath, personaContent);

    // Prepare context file
    const contextPath = path.join(workflowRunDir, 'context.json');
    fs.writeFileSync(contextPath, JSON.stringify(agentInput.workspaceContext, null, 2));

    // Prepare input file
    const inputPath = path.join(workflowRunDir, 'input.txt');
    fs.writeFileSync(inputPath, agentInput.input);

    const maxRetries = stepDef.max_retries || 3;

    const prompt = `You are the ${agent.name} agent in a workflow.

${agent.persona}

WORKFLOW CONTEXT:
- Run ID: ${agentInput.runId}
- Step: ${agentInput.stepId}
- Workspace: ${workflowRunDir}

INPUT:
${agentInput.input}

Previous outputs:
${JSON.stringify(agentInput.workspaceContext.previousOutputs, null, 2)}

Complete your task. When done, output your result clearly.
${stepDef.expects ? `Your output should contain: ${stepDef.expects}` : ''}

Artifacts you create should be saved in: ${workflowRunDir}
`;

    try {
      // Track this container for potential cancellation
      let containerProcess: any = null;

      const output = await runContainerAgent(
        group,
        {
          prompt,
          groupFolder: group.folder,
          chatJid: group.jid,
          isMain: group.folder === 'main',
          singleMessage: true,
          timeout: stepDef.timeout || agent.timeout || 300000, // 5 min default
        },
        (proc) => {
          // Track the container process
          containerProcess = proc;
          const containers = this.activeContainers.get(agentInput.runId) || [];
          containers.push(proc);
          this.activeContainers.set(agentInput.runId, containers);
        },
        undefined, // onOutput - no streaming for workflow steps
      );

      // Clear container tracking for this specific container
      const containers = this.activeContainers.get(agentInput.runId) || [];
      const index = containers.indexOf(containerProcess);
      if (index > -1) {
        containers.splice(index, 1);
      }
      if (containers.length === 0) {
        this.activeContainers.delete(agentInput.runId);
      } else {
        this.activeContainers.set(agentInput.runId, containers);
      }

      const totalDurationMs = Date.now() - containerStartTime;

      if (output.status === 'success' && output.result) {
        // Check if expected output is present
        if (stepDef.expects && !output.result.includes(stepDef.expects)) {
          logger.warn(
            { stepId: agentInput.stepId, expected: stepDef.expects, got: output.result.slice(0, 100) },
            'Step output missing expected marker',
          );
          // Continue anyway - agent might have still done useful work
        }

        // Scan for artifacts
        const artifacts = this.scanArtifacts(workflowRunDir, agentInput.runId, agentInput.stepId);

        return {
          success: true,
          output: output.result,
          artifacts,
          timing: {
            containerStartMs: 0, // Can't measure without container-ready callback
            agentExecutionMs: totalDurationMs,
          },
        };
      } else {
        // Check if retries exceeded
        const maxRetries = stepDef.max_retries || 3;
        const currentRetries = stepExec.retries || 0;

        if (currentRetries >= maxRetries) {
          return {
            success: false,
            error: output.error || 'Unknown error',
            shouldRetry: false,
            shouldEscalate: stepDef.on_failure === 'escalate',
          };
        }

        return {
          success: false,
          error: output.error || 'Unknown error',
          shouldRetry: true,
        };
      }
    } catch (err) {
      const maxRetries = stepDef.max_retries || 3;
      const currentRetries = stepExec.retries || 0;

      if (currentRetries >= maxRetries) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          shouldRetry: false,
          shouldEscalate: stepDef.on_failure === 'escalate',
        };
      }

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        shouldRetry: true,
      };
    }
  }

  /**
   * Scan workflow output directory for artifacts
   */
  private scanArtifacts(workflowRunDir: string, runId: string, stepId: string): any[] {
    const artifacts: any[] = [];

    if (!fs.existsSync(workflowRunDir)) {
      return artifacts;
    }

    const files = fs.readdirSync(workflowRunDir, { recursive: true }) as string[];

    for (const file of files) {
      const fullPath = path.join(workflowRunDir, file);

      // Skip directories and metadata files
      if (fs.statSync(fullPath).isDirectory() || file === 'context.json' || file === 'input.txt') {
        continue;
      }

      const ext = path.extname(file);
      const type = ext === '.md' ? 'plan' : ext === '.ts' || ext === '.js' ? 'code' : 'file';

      artifacts.push({
        run_id: runId,
        step_id: stepId,
        artifact_type: type,
        path: fullPath,
        metadata: JSON.stringify({ filename: file }),
        created_at: new Date().toISOString(),
      });
    }

    return artifacts;
  }

  /**
   * Extract variables from previous step outputs
   * Handles structured agent outputs and creates accessible template variables
   */
  private extractVariablesFromOutputs(outputs: Record<string, string>): Record<string, string> {
    const variables: Record<string, string> = {};

    for (const [stepId, output] of Object.entries(outputs)) {
      // Store the full output for this step
      variables[stepId] = output;

      // Special handling for 'plan' step - extract individual stories
      if (stepId === 'plan') {
        const stories = this.extractStoriesFromPlan(output);
        for (const [num, content] of Object.entries(stories)) {
          variables[`${stepId}.story_${num}`] = content;
        }
      }

      // Try to parse as JSON for structured data
      try {
        const parsed = JSON.parse(output);
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' || typeof value === 'number') {
              variables[`${stepId}.${key}`] = String(value);
            }
          }
        }
      } catch {
        // Not JSON - try to extract common patterns
        this.extractKeyValuePairs(output, stepId, variables);
      }
    }

    return variables;
  }

  /**
   * Evaluate a step condition against current context
   */
  private evaluateCondition(
    condition: any,
    previousOutputs: Record<string, string>,
    contextVariables: Record<string, string>
  ): boolean {
    // Validate condition structure
    if (!condition || !condition.operator || !condition.variable) {
      logger.warn({ condition }, 'Invalid condition structure, defaulting to false');
      return false;
    }

    // Get the variable value
    let actualValue: any;

    // Handle special variable paths
    if (condition.variable === 'task.result') {
      actualValue = contextVariables.task || '';
    } else if (condition.variable.startsWith('previousSteps.')) {
      // Extract step ID from path like "previousSteps.plan.output"
      const pathParts = condition.variable.split('.');
      if (pathParts.length < 2) {
        logger.warn({ variable: condition.variable }, 'Invalid previousSteps path format');
        return false;
      }
      const stepId = pathParts[1];
      if (!stepId) {
        logger.warn({ variable: condition.variable }, 'Missing step ID in previousSteps path');
        return false;
      }
      actualValue = previousOutputs[stepId] || '';
    } else {
      // Try to get from context variables
      actualValue = contextVariables[condition.variable];
    }

    // Evaluate condition based on operator
    switch (condition.operator) {
      case 'equals':
        return String(actualValue ?? '') === String(condition.value ?? '');
      case 'not_equals':
        return String(actualValue ?? '') !== String(condition.value ?? '');
      case 'contains':
        return String(actualValue ?? '').includes(String(condition.value ?? ''));
      case 'starts_with':
        return String(actualValue ?? '').startsWith(String(condition.value ?? ''));
      case 'ends_with':
        return String(actualValue ?? '').endsWith(String(condition.value ?? ''));
      case 'greater_than': {
        const actualNum = parseFloat(String(actualValue ?? ''));
        const expectedNum = parseFloat(String(condition.value ?? '0'));
        if (isNaN(actualNum) || isNaN(expectedNum)) {
          logger.warn({ actualValue, condition, actualNum, expectedNum }, 'Non-numeric value in greater_than comparison');
          return false;
        }
        return actualNum > expectedNum;
      }
      case 'less_than': {
        const actualNum = parseFloat(String(actualValue ?? ''));
        const expectedNum = parseFloat(String(condition.value ?? '0'));
        if (isNaN(actualNum) || isNaN(expectedNum)) {
          logger.warn({ actualValue, condition, actualNum, expectedNum }, 'Non-numeric value in less_than comparison');
          return false;
        }
        return actualNum < expectedNum;
      }
      case 'exists':
        return actualValue !== undefined && actualValue !== null && actualValue !== '';
      case 'not_exists':
        return actualValue === undefined || actualValue === null || actualValue === '';
      default:
        logger.warn({ operator: condition.operator }, 'Unknown condition operator, defaulting to false');
        return false; // Changed from true to false for safety
    }
  }

  /**
   * Extract stories from planner output
   */
  private extractStoriesFromPlan(planOutput: string): Record<string, string> {
    const stories: Record<string, string> = {};
    const lines = planOutput.split('\n');
    let currentStory: string[] = [];
    let storyNum = 0;

    for (const line of lines) {
      const storyMatch = line.match(/^STORY:\s*(\d+)\s+(.+)/);
      if (storyMatch) {
        // Save previous story if exists
        if (currentStory.length > 0) {
          stories[String(storyNum)] = currentStory.join('\n');
          currentStory = [];
        }
        storyNum = parseInt(storyMatch[1], 10);
        currentStory.push(line);
      } else if (storyNum > 0 && currentStory.length > 0) {
        // Accumulate story content
        currentStory.push(line);
      }
    }

    // Save last story
    if (currentStory.length > 0) {
      stories[String(storyNum)] = currentStory.join('\n');
    }

    return stories;
  }

  /**
   * Extract key-value pairs from text output
   */
  private extractKeyValuePairs(output: string, stepId: string, variables: Record<string, string>): void {
    const lines = output.split('\n');
    for (const line of lines) {
      // Match patterns like "KEY: value" (uppercase keys)
      const match = line.match(/^([A-Z_][A-Z0-9_]*):\s*(.+)$/);
      if (match) {
        const key = match[1].toLowerCase();
        variables[`${stepId}.${key}`] = match[2].trim();
      }
    }
  }

  /**
   * Pause a running workflow
   */
  pauseRun(runId: string): void {
    this.running.set(runId, false);
    updateWorkflowRunStatus(runId, 'paused');
    logger.info({ workflowRunId: runId }, 'Workflow run paused');
  }

  /**
   * Resume a paused workflow
   */
  async resumeRun(runId: string): Promise<void> {
    const run = getWorkflowRun(runId);
    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    if (run.status !== 'paused') {
      throw new Error(`Workflow run ${runId} is not paused (status: ${run.status})`);
    }

    // Check if already running (prevent duplicate resume calls)
    if (this.running.get(runId)) {
      logger.warn({ workflowRunId: runId }, 'Workflow is already running, ignoring duplicate resume');
      return;
    }

    const workflow = this.loadWorkflow(run.workflow_id);
    if (!workflow) {
      throw new Error(`Workflow ${run.workflow_id} not found`);
    }

    this.running.set(runId, true);
    updateWorkflowRunStatus(runId, 'running');

    // Resume execution
    this.executeSteps(runId, workflow).catch((err) => {
      logger.error({ workflowRunId: runId, error: err }, 'Workflow resume error');
      updateWorkflowRunStatus(runId, 'failed');
      this.running.delete(runId);
      this.workflowStartTimes.delete(runId);
      this.workflowCallStack.delete(runId);
      this.activeContainers.delete(runId);
    });

    logger.info({ workflowRunId: runId }, 'Workflow run resumed');
  }

  /**
   * Close all active containers for a workflow run
   */
  private closeAllContainers(runId: string): void {
    const containers = this.activeContainers.get(runId) || [];
    const run = getWorkflowRun(runId);

    for (const container of containers) {
      try {
        const closePath = path.join(GROUPS_DIR, run?.group_id || '', 'workflow-output', runId, 'input', '_close');
        fs.mkdirSync(path.dirname(closePath), { recursive: true });
        fs.writeFileSync(closePath, 'close');
        logger.debug({ workflowRunId: runId }, 'Sent _close signal to container');
      } catch (err) {
        logger.warn({ workflowRunId: runId, error: err }, 'Failed to send _close signal to container');
      }
    }

    // Clear all containers
    this.activeContainers.delete(runId);
  }

  /**
   * Cancel a workflow run
   */
  cancelRun(runId: string): void {
    // Close all active containers
    this.closeAllContainers(runId);

    this.running.set(runId, false);
    updateWorkflowRunStatus(runId, 'failed');
    this.running.delete(runId);
    this.activeContainers.delete(runId);
    this.workflowStartTimes.delete(runId);
    this.workflowCallStack.delete(runId);
    logger.info({ workflowRunId: runId }, 'Workflow run cancelled');
  }

  /**
   * Retry a single failed step
   */
  async retryStep(runId: string, stepId: string): Promise<boolean> {
    const run = getWorkflowRun(runId);
    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }

    const workflow = this.loadWorkflow(run.workflow_id);
    if (!workflow) {
      throw new Error(`Workflow ${run.workflow_id} not found`);
    }

    // Get the step execution record
    const steps = getWorkflowSteps(runId);
    const stepExec = steps.find((s) => s.step_id === stepId);
    if (!stepExec) {
      throw new Error(`Step ${stepId} not found in workflow run ${runId}`);
    }

    if (stepExec.status !== 'failed') {
      throw new Error(`Step ${stepId} is not in failed state (current: ${stepExec.status})`);
    }

    // Reset step to pending
    updateWorkflowStepStatus(stepExec.id, 'pending');
    incrementStepRetries(stepExec.id);

    // Resume workflow execution
    this.running.set(runId, true);
    updateWorkflowRunStatus(runId, 'running');

    logger.info({ workflowRunId: runId, stepId }, 'Retrying workflow step');

    // Resume execution
    this.executeSteps(runId, workflow).catch((err) => {
      logger.error({ workflowRunId: runId, error: err }, 'Workflow retry error');
      updateWorkflowRunStatus(runId, 'failed');
      this.running.delete(runId);
      this.workflowStartTimes.delete(runId);
      this.workflowCallStack.delete(runId);
      this.activeContainers.delete(runId);
    });

    return true;
  }

  /**
   * Resume a paused workflow with user input
   */
  async resumeWorkflow(runId: string, userInput: string): Promise<{ success: boolean; message: string }> {
    const run = getWorkflowRun(runId);
    if (!run) {
      return { success: false, message: `Workflow run ${runId} not found` };
    }

    if (run.status !== 'paused') {
      return { success: false, message: `Workflow is not paused (current status: ${run.status})` };
    }

    // Validate user input
    if (!userInput || userInput.trim().length === 0) {
      return { success: false, message: 'User input cannot be empty' };
    }

    const workflow = this.loadWorkflow(run.workflow_id);
    if (!workflow) {
      return { success: false, message: `Workflow ${run.workflow_id} not found` };
    }

    // Find the paused step
    const steps = getWorkflowSteps(runId);
    const pausedStep = steps.find((s) => s.status === 'paused');

    if (!pausedStep) {
      return { success: false, message: 'No paused step found in workflow' };
    }

    logger.info({ workflowRunId: runId, stepId: pausedStep.step_id, userInput }, 'Resuming workflow with user input');

    // Update context with user input
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(run.context);
    } catch {
      context = {};
    }
    context.userInput = userInput;
    context.userInputStepId = pausedStep.step_id;
    updateWorkflowRunContext(runId, JSON.stringify(context));

    // Mark step as completed (it already produced output before pausing)
    updateWorkflowStepStatus(pausedStep.id, 'completed', pausedStep.output);

    // Resume workflow execution
    this.running.set(runId, true);
    updateWorkflowRunStatus(runId, 'running');

    logger.info({ workflowRunId: runId, stepId: pausedStep.step_id }, 'Workflow resumed');

    // Resume execution
    this.executeSteps(runId, workflow).catch((err) => {
      logger.error({ workflowRunId: runId, error: err }, 'Workflow resume error');
      updateWorkflowRunStatus(runId, 'failed');
      this.running.delete(runId);
      this.workflowStartTimes.delete(runId);
      this.workflowCallStack.delete(runId);
      this.activeContainers.delete(runId);
    });

    return { success: true, message: `Workflow resumed with your input` };
  }

  /**
   * Get workflow status
   */
  getStatus(runId: string): any {
    const run = getWorkflowRun(runId);
    if (!run) {
      return null;
    }

    const steps = getWorkflowSteps(runId);
    const progress = getWorkflowProgress(runId);
    const currentStep = steps.find((s) => s.status === 'running');

    return {
      run,
      steps,
      currentStep,
      progress,
    };
  }

  /**
   * List workflows for a group
   */
  listWorkflows(groupId: string): any[] {
    return listWorkflowRuns(groupId);
  }

  /**
   * Get all active runs
   */
  getActiveRuns(): any[] {
    return getActiveWorkflowRuns();
  }

  /**
   * Get all runnable steps (supports parallel groups and conditional execution)
   */
  private getAllRunnableSteps(
    runId: string,
    stepDependencies: Map<string, string[]>,
    steps: any[],
    workflow: WorkflowDefinition,
  ): WorkflowStepExecution[] {
    const runnable: WorkflowStepExecution[] = [];
    const allSteps = getWorkflowSteps(runId);
    const run = getWorkflowRun(runId);

    // Get previous outputs for condition evaluation
    const previousOutputs: Record<string, string> = {};
    for (const s of allSteps) {
      if (s.status === 'completed' && s.output) {
        previousOutputs[s.step_id] = s.output;
      }
    }

    // Get context variables from run (with error handling)
    let contextVariables: Record<string, string> = {};
    if (run) {
      try {
        contextVariables = JSON.parse(run.context);
      } catch {
        contextVariables = {};
      }
    }

    for (const stepExec of allSteps) {
      if (stepExec.status !== 'pending') continue;

      // Check if all dependencies are satisfied
      const deps = stepDependencies.get(stepExec.step_id) || [];
      const completedDeps = allSteps.filter(
        (s) => deps.includes(s.step_id) && s.status === 'completed'
      );

      if (completedDeps.length !== deps.length) {
        continue; // Dependencies not satisfied
      }

      // Check condition if present
      const stepDef = workflow.steps.find((s) => s.id === stepExec.step_id);
      if (stepDef?.condition) {
        const conditionMet = this.evaluateCondition(stepDef.condition, previousOutputs, contextVariables);
        if (!conditionMet) {
          // Condition not met - mark step as skipped
          updateWorkflowStepStatus(stepExec.id, 'skipped');
          logger.info(
            { workflowRunId: runId, stepId: stepExec.step_id, condition: stepDef.condition },
            'Step condition not met, skipping'
          );
          continue;
        }
      }

      runnable.push(stepExec);
    }

    return runnable;
  }

  /**
   * Group steps by parallel_group
   */
  private groupStepsByParallel(
    steps: WorkflowStepExecution[],
    workflow: WorkflowDefinition,
  ): Map<string, WorkflowStepExecution[]> {
    const groups = new Map<string, WorkflowStepExecution[]>();
    const processedIds = new Set<string>();

    for (const stepExec of steps) {
      if (processedIds.has(stepExec.id)) continue;

      const stepDef = workflow.steps.find((s) => s.id === stepExec.step_id);
      // Use unique group if no parallel_group or if parallel_group is empty string
      const groupName = (stepDef?.parallel_group && stepDef.parallel_group.trim().length > 0)
        ? stepDef.parallel_group.trim()
        : `_${stepExec.step_id}`; // Unique group if no parallel_group

      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }

      groups.get(groupName)!.push(stepExec);
      processedIds.add(stepExec.id);
    }

    return groups;
  }

  /**
   * Save workflow completion to memory
   */
  private saveWorkflowMemory(
    runId: string,
    workflowId: string,
    input: string,
    status: WorkflowRunStatus,
    steps: any[],
  ): void {
    const run = getWorkflowRun(runId);
    if (!run) return;

    const completedSteps = steps.filter(s => s.status === 'completed').length;
    const failedSteps = steps.filter(s => s.status === 'failed').length;

    let memoryContent = `Workflow ${workflowId} ${status}.\n`;
    memoryContent += `Input: ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}\n`;
    memoryContent += `Steps: ${completedSteps} completed`;

    if (failedSteps > 0) {
      memoryContent += `, ${failedSteps} failed`;
    }

    memoryContent += `.`;

    // Save as an event memory type for easy retrieval
    try {
      saveMemory({
        agent_folder: run.group_id,
        memory_type: 'event',
        content: memoryContent,
        importance: status === 'completed' ? 5 : 3,
      });
      logger.info({ workflowRunId: runId, group: run.group_id }, 'Workflow saved to memory');
    } catch (err) {
      logger.warn({ workflowRunId: runId, error: err }, 'Failed to save workflow to memory');
    }
  }
}

// Singleton instance
export const workflowEngine = new WorkflowEngine();
