# Multi-Agent Workflow System - Complete Documentation

## Overview

NanoClaw now includes a complete multi-agent workflow orchestration system inspired by Antfarm, adapted to NanoClaw's architecture. This allows you to run complex, multi-step development workflows (feature development, bug fixes) from any channel (webOS chat, WhatsApp, etc.).

**Key Design Principle:** Workflows run on the host (NanoClaw process), not via MCP delegation. Each step spawns a fresh container with the agent's persona.

## Table of Contents

- [Quick Start](#quick-start)
- [Available Workflows](#available-workflows)
- [Usage](#usage)
- [Architecture](#architecture)
- [File Structure](#file-structure)
- [Database Schema](#database-schema)
- [Agent Personas](#agent-personas)
- [Creating Custom Workflows](#creating-custom-workflows)
- [API Reference](#api-reference)

---

## Quick Start

### 1. Start a workflow

From any channel (webOS chat, WhatsApp, etc.):

```
Start feature-dev workflow to add OAuth authentication
```

Or use shortcuts:
```
Feature add user authentication
Bug fix the login crash
```

### 2. Check status

```
workflow status
```

### 3. List workflows

```
list workflows
```

### 4. Control workflows

```
pause workflow abc12345
resume workflow abc12345
cancel workflow abc12345
```

---

## Available Workflows

### feature-dev (7 agents)

**Purpose:** Break down a feature into stories, implement each with verification and testing.

**Agents:**
1. **Planner** - Breaks feature into 3-7 stories with acceptance criteria
2. **Setup** - Prepares development environment
3. **Developer** - Implements each story (one at a time)
4. **Verifier** - Verifies each story meets acceptance criteria
5. **Tester** - Writes and runs tests for each story
6. **PR Agent** - Creates pull request with documentation
7. **Reviewer** - Final code review before completion

**Flow:**
```
plan → setup → [story_1: develop → verify → test]
                [story_2: develop → verify → test]
                ...
                [story_7: develop → verify → test]
                → create_pr → final_review
```

### bug-fix (6 agents)

**Purpose:** Reproduce bugs, find root causes, implement fixes with regression tests.

**Agents:**
1. **Triager** - Reproduces and characterizes bugs
2. **Investigator** - Finds root cause
3. **Setup** - Prepares for fix
4. **Fixer** - Implements minimal fix
5. **Verifier** - Verifies fix works and checks for regressions
6. **PR Agent** - Creates pull request documenting the fix

**Flow:**
```
triage → investigate → setup → fix → verify → create_pr
```

---

## Usage

### Natural Language Commands

The system detects workflow intent from your messages:

**Start workflows:**
- `Start feature-dev workflow to add user authentication`
- `Start bug-fix workflow to fix the search bug`
- `Feature add dark mode` (shortcut)
- `Bug fix the login crash` (shortcut)

**Check status:**
- `workflow status` - Shows most recent workflow
- `workflow status abc12345` - Shows specific workflow
- `How's the workflow going?` (natural language)

**List workflows:**
- `list workflows` - Shows all workflow runs
- `available workflows` - Shows workflow definitions

**Control:**
- `pause workflow abc12345`
- `resume workflow abc12345`
- `cancel workflow abc12345`

### Agent Tools

Agents can invoke workflows via MCP tools:

```typescript
// Available tools
start_workflow(workflow_id, task)
workflow_status(run_id?)
list_workflows(type?: 'available' | 'runs')
pause_workflow(run_id)
resume_workflow(run_id)
cancel_workflow(run_id)
```

Example agent usage:
```
"Start the feature-dev workflow to implement the user's request"
```

---

## Architecture

```
User Message (webOS/WhatsApp/etc.)
        ↓
detectWorkflowIntent() - Parse natural language
        ↓
workflowEngine.startRun() - Create run in DB
        ↓
executeSteps() - Main orchestration loop
        ↓
┌─────────────────────────────────────┐
│ While workflow is running:            │
│   1. getNextRunnableStep()           │
│   2. executeStep()                   │
│      ├─ runContainerAgent()           │
│      ├─ Load agent persona            │
│      ├─ Execute in container          │
│      └─ Collect results              │
│   3. updateWorkflowStepStatus()       │
│   4. Pass context to next step       │
│   5. Repeat until all steps complete │
└─────────────────────────────────────┘
        ↓
Workflow complete → Send summary to user
```

### Key Design Decisions

1. **Host orchestration** - WorkflowEngine runs on host, not in containers
2. **Fresh containers per step** - Each step gets a clean container with agent persona
3. **File-based context passing** - Variables passed via JSON files in workspace
4. **SQLite state tracking** - All workflow state in database
5. **No MCP delegation** - Avoids delegation issues; MCP tools just write IPC files

---

## File Structure

```
nanoclaw/
├── src/
│   ├── workflow-types.ts          # TypeScript interfaces
│   ├── workflow-parser.ts         # YAML parser & validator
│   ├── workflow-db.ts             # Database operations
│   ├── workflow-engine.ts          # Core orchestration engine
│   ├── workflow-router.ts         # Intent detection & routing
│   └── workflow.test.ts            # Test suite
├── workflows/                      # Workflow definitions
│   ├── feature-dev/
│   │   ├── workflow.yaml          # Workflow definition
│   │   └── agents/                # Agent personas
│   │       ├── planner.md
│   │       ├── developer.md
│   │       ├── verifier.md
│   │       ├── tester.md
│   │       ├── setup.md
│   │       ├── pr.md
│   │       └── reviewer.md
│   └── bug-fix/
│       ├── workflow.yaml
│       └── agents/
│           ├── triager.md
│           ├── investigator.md
│           ├── fixer.md
│           ├── setup.md
│           ├── verifier.md
│           └── pr.md
├── groups/
│   └── {group-name}/
│       └── workflow-output/
│           └── {run-id}/           # Per-run artifacts
│               ├── context.json
│               ├── input.txt
│               └── agents/
└── docs/
    ├── WORKFLOW_DOD.md            # Original definition of done
    └── WORKFLOW_IMPLEMENTATION.md # Implementation summary
```

---

## Database Schema

```sql
-- Workflow runs
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending','running','paused','completed','failed','escalated')),
  input TEXT,
  context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (group_id) REFERENCES registered_groups(folder)
);

-- Workflow steps
CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending','running','completed','failed','skipped')),
  input TEXT,
  output TEXT,
  error TEXT,
  retries INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

-- Workflow artifacts
CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  artifact_type TEXT,
  path TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
```

---

## Agent Personas

Each agent has a persona defined in Markdown that specifies:
- Their role and responsibilities
- Process to follow
- Output format expected
- Guidelines for quality

### Example: Developer Agent Persona

```markdown
# Developer Agent

You are a full-stack developer implementing features according to specifications.

## Your Process

1. **Read the story requirements carefully**
   - Understand what needs to be built
   - Note all acceptance criteria
   - Identify edge cases

2. **Examine existing code patterns**
   - Look at similar code in the project
   - Follow established conventions

3. **Implement the feature**
   - Write clean, well-documented code
   - Include error handling
   - Handle edge cases

## Output Format

When complete:
```
IMPLEMENTATION: complete
FILES_MODIFIED: [list of files]
SUMMARY: [brief description]
```
```

---

## Creating Custom Workflows

### Workflow Definition Format

```yaml
id: my-workflow
name: My Custom Workflow
description: What this workflow does
version: 1.0.0

agents:
  - id: myagent
    name: My Agent
    persona: |
      You are a specialist agent...
    workspace:
      mount: "."
      files: {}

steps:
  - id: step1
    agent: myagent
    input: |
      Task: {{task}}
      Do something...
    expects: "DONE"
    max_retries: 3
    on_failure: retry
```

### Step Properties

- **id**: Unique step identifier
- **agent**: Which agent executes this step
- **input**: Prompt template (supports `{{variable}}` interpolation)
- **expects**: Expected output marker (optional)
- **depends_on**: Array of step IDs that must complete first
- **max_retries**: Retry limit (default: 3)
- **on_failure**: `retry`, `escalate`, or `skip`

### Variable Interpolation

Variables are passed between steps:

```yaml
# Available variables:
{{task}}        # Original workflow input
{{plan}}        # Full output of 'plan' step
{{plan.story_1}} # Extracted story from planner
{{fix.output}}  # Output from 'fix' step
```

---

## API Reference

### WorkflowEngine Class

```typescript
class WorkflowEngine {
  // Load and validate workflow definition
  loadWorkflow(id: string): WorkflowDefinition | null

  // Start a new workflow run
  startRun(workflowId: string, groupId: string, input: string): Promise<string | null>

  // Pause a running workflow
  pauseRun(runId: string): void

  // Resume a paused workflow
  resumeRun(runId: string): Promise<void>

  // Cancel a workflow
  cancelRun(runId: string): void

  // Get workflow status
  getStatus(runId: string): WorkflowStatus

  // List workflows for a group
  listWorkflows(groupId: string): WorkflowSummary[]
}
```

### Database Operations

```typescript
// Workflow runs
createWorkflowRun(workflowId, groupId, input): string
getWorkflowRun(id): WorkflowRun | undefined
updateWorkflowRunStatus(id, status, context?): void
listWorkflowRuns(groupId?): WorkflowSummary[]

// Workflow steps
createWorkflowSteps(runId, steps): void
getWorkflowSteps(runId): WorkflowStepExecution[]
getPendingSteps(runId): WorkflowStepExecution[]
getNextRunnableStep(runId, stepDependencies): WorkflowStepExecution | undefined
updateWorkflowStepStatus(id, status, output?, error?): void
incrementStepRetries(id): void

// Workflow artifacts
createWorkflowArtifact(runId, stepId, type, path, metadata): string
getWorkflowArtifacts(runId, stepId?): WorkflowArtifact[]
getWorkflowProgress(runId): {total, completed, failed, running, pending}
```

---

## Examples

### Example 1: Feature Development

```
You: Start feature-dev workflow to add user profile pages

Agent: Starting feature-dev workflow (ID: abc12345)...

[Planner breaks it into 5 stories]

[Developer implements story 1]
[Verifier checks story 1]
[Tester tests story 1]

[... continues through all stories]

Agent: Feature complete! 5 stories implemented, all tests passing.
     PR ready at groups/myproject/pr/3
```

### Example 2: Bug Fix

```
You: Bug fix the search returns no results for special characters

Agent: Starting bug-fix workflow...

[Triager reproduces bug]
[Investigator finds root cause: unescaped regex characters]
[Fixer implements escape function]
[Verifier confirms fix works]
[Tester adds regression test]

Agent: Bug fixed! Search now handles special characters correctly.
     PR created with regression tests.
```

### Example 3: Checking Status

```
You: workflow status

Agent: **Workflow: feature-dev**
Status: running
Progress: 2/5 stories completed

Steps:
  ✓ plan (planner)
  ✓ setup (setup)
  ▶ story_1_implement (developer)
  ○ story_1_verify (verifier)
  ○ story_1_test (tester)
  ...
```

---

## Testing

All tests pass (11/11):

```bash
npm test -- src/workflow.test.ts
```

Test coverage:
- Workflow YAML parsing and validation
- Workflow engine operations
- Database operations
- Intent detection
- Status formatting

---

## Troubleshooting

### Workflow not starting?

1. Check workflow is in `workflows/` directory
2. Validate YAML syntax: `npm run build`
3. Check logs: `groups/{group}/logs/`

### Steps stuck pending?

1. Check dependencies are satisfied
2. Verify previous steps completed
3. Check for circular dependencies in YAML

### Agent not getting context?

1. Verify agent persona file exists
2. Check `workflow-output/{run-id}/context.json`
3. Ensure variables are properly extracted

### Container timeout?

1. Check step timeout in workflow YAML
2. Increase agent timeout in agent persona
3. Verify task isn't too large

---

## Security Considerations

1. **Curated workflows only** - Only workflows from official `workflows/` directory
2. **Agent isolation** - Each step runs in fresh container
3. **Filesystem sandbox** - Agents only see mounted directories
4. **No code execution** - Workflows are declarative YAML

---

## Performance Notes

- **Concurrency:** Each workflow run is independent
- **Resource usage:** One container per step (not all at once)
- **Database:** SQLite for state (minimal overhead)
- **Context passing:** File-based (git-friendly)

---

## Advanced Features (Recently Added)

### Conditional Branching

Steps can execute conditionally based on previous results:

```yaml
steps:
  - id: analyze
    agent: analyzer
    input: "Analyze the request"
    condition:
      variable: "task.result"
      operator: "contains"
      value: "bug"
```

Available operators: `equals`, `not_equals`, `contains`, `starts_with`, `ends_with`, `greater_than`, `less_than`, `exists`, `not_exists`.

### Parallel Execution

Run independent steps simultaneously using `parallel_group`:

```yaml
steps:
  - id: test-backend
    agent: tester
    input: "Test backend"
    parallel_group: tests

  - id: test-frontend
    agent: tester
    input: "Test frontend"
    parallel_group: tests
```

### Sub-Workflows

Compose workflows from reusable templates:

```yaml
steps:
  - id: implement
    agent: developer
    sub_workflow: backend-implementation
    depends_on:
      - plan
```

### Workflow Templates

Define reusable workflow templates with parameters:

```yaml
id: blog-post
name: Blog Post Generator
is_template: true
template_params:
  - name: topic
    type: text
    required: true
  - name: tone
    type: select
    options: [professional, casual, technical]
    default: professional
```

Instantiate: `@Andy run blog-post workflow with topic="AI safety", tone=technical`

### Interactive Workflows

Pause for human input mid-execution:

```yaml
steps:
  - id: review
    agent: reviewer
    input: "Review the changes"
    pause_for_input: true
    input_prompt: "Please provide your feedback"
```

### Workflow Scheduling

Schedule recurring workflow executions:

```
@Andy schedule code-review workflow every Monday at 9am
@Andy schedule weekly-report workflow every Friday at 5pm
```

### Workflow Versioning

Track multiple versions of workflows:

```
@Andy show all versions of code-review workflow
@Andy run code-review-v2 workflow to review PR #123
```

## Future Enhancements

Potential improvements for future versions:

1. **Workflow marketplace** - Share workflows between users
2. **Visual editor** - GUI for creating workflows
3. **Workflow analytics** - Track success rates, timing metrics

---

## Summary

The workflow system provides:

- ✅ Two production-ready workflows (feature-dev, bug-fix)
- ✅ Natural language interface from any channel
- ✅ Agent tools for workflow invocation
- ✅ SQLite persistence and state tracking
- ✅ Comprehensive error handling and retry logic
- ✅ Pause/resume/cancel controls
- ✅ Artifact tracking
- ✅ Full test coverage
- ✅ Zero infrastructure overhead (uses existing NanoClaw systems)

**Total files created:** 15+
**Total lines of code:** ~2,500+
**Test coverage:** 11/11 tests passing
