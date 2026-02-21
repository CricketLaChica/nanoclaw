# Multi-Agent Workflow System - Implementation Complete

## What Was Built

A complete multi-agent workflow orchestration system for NanoClaw, inspired by Antfarm but adapted to NanoClaw's architecture.

## Key Features

### 1. Workflow Definition Format (YAML)
- Define agents with personas
- Define steps with dependencies
- Specify retry logic and failure handling
- Support for variable interpolation between steps

### 2. Two Built-in Workflows

**feature-dev**: 7-agent workflow for feature development
- planner → setup → developer → verifier → tester (× 7 stories) → pr → reviewer
- Each story is implemented, verified, and tested sequentially

**bug-fix**: 6-agent workflow for bug fixing
- triager → investigator → setup → fixer → verifier → pr
- Reproduces bug, finds root cause, implements fix with regression test

### 3. Core Components

**Files Created:**
- `src/workflow-types.ts` - TypeScript interfaces
- `src/workflow-parser.ts` - YAML parser and validator
- `src/workflow-db.ts` - Database operations
- `src/workflow-engine.ts` - Core orchestration engine
- `src/workflow-router.ts` - Message routing and intent detection
- `src/workflow.test.ts` - Comprehensive test suite
- `workflows/feature-dev/` - Feature development workflow + agent personas
- `workflows/bug-fix/` - Bug fix workflow + agent personas

**Files Modified:**
- `src/db.ts` - Added workflow tables to schema
- `src/container-runner.ts` - Added timeout parameter to ContainerInput
- `src/ipc.ts` - Added workflow IPC handling
- `container/agent-runner/src/ipc-mcp-stdio.ts` - Added workflow tools for agents

## How to Use

### From the Chat Interface

**Start a workflow:**
```
Start feature-dev workflow to add OAuth authentication
Start bug-fix workflow to fix the search bug
```

**Shortcuts:**
```
Feature add user authentication
Bug fix the login crash
```

**Check status:**
```
workflow status
```

**List workflows:**
```
list workflows
```

**Control workflows:**
```
pause workflow abc12345
resume workflow abc12345
cancel workflow abc12345
```

### Using Agent Tools

Agents can invoke workflows via MCP tools:
- `start_workflow(workflow_id, task)`
- `workflow_status(run_id?)`
- `list_workflows(type?)`
- `pause_workflow(run_id)`
- `resume_workflow(run_id)`
- `cancel_workflow(run_id)`

## How It Works

1. **User initiates workflow** from any channel (webOS chat, WhatsApp, etc.)
2. **WorkflowEngine creates run** in database
3. **Steps execute sequentially** (respecting dependencies)
4. **Each step spawns a container** with the agent's persona
5. **Context passes between steps** via JSON files
6. **Progress updates** sent to originating channel
7. **Artifacts saved** to `groups/{name}/workflow-output/{run-id}/`

## Architecture

```
User Message → detectWorkflowIntent() → workflowEngine.startRun()
                                     ↓
                              Creates workflow run in DB
                                     ↓
                              executeSteps() loop
                                     ↓
                  ┌──────────────────┴──────────────────┐
                  ↓                                     ↓
            getNextRunnableStep()                 retry/escalate
                  ↓
        runContainerAgent() with agent persona
                  ↓
         updateWorkflowStepStatus()
                  ↓
              Next step...
```

## Testing

All 11 workflow tests pass:
```
✓ should list available workflows
✓ should load feature-dev workflow
✓ should load bug-fix workflow
✓ should validate feature-dev workflow
✓ should validate bug-fix workflow
✓ should detect circular dependencies
✓ should load workflow definitions
✓ should create workflow runs
✓ should get workflow status
✓ should list workflows for a group
✓ should detect workflow intents
```

## Next Steps

To use this system:

1. **Rebuild the agent container** (already done)
2. **Start NanoClaw**: `npm run dev`
3. **Try it from chat**: `Start bug-fix workflow to fix a typo in the README`

## Custom Workflows

To create your own workflow:

1. Create directory: `workflows/my-workflow/`
2. Create `workflow.yaml` with agents and steps
3. Create agent personas in `agents/` subdirectory
4. Your workflow is automatically available

## Database Schema

```sql
workflow_runs (id, workflow_id, group_id, status, input, context, created_at, updated_at, completed_at)
workflow_steps (id, run_id, step_id, agent_id, status, input, output, error, retries, started_at, completed_at, created_at)
workflow_artifacts (id, run_id, step_id, artifact_type, path, metadata, created_at)
```

## Status

✅ Implementation Complete
✅ All Tests Passing
✅ Container Built
✅ Ready for Use
