# Multi-Agent Workflow System - Definition of Done

> Port of Antfarm's workflow pattern to NanoClaw architecture

---

## Vision Statement

Enable agents to orchestrate multi-agent workflows for complex tasks like feature development, bug fixes, and security audits. Users initiate workflows from any channel (webOS chat, WhatsApp, etc.), and specialized subagents collaborate deterministically to produce production-ready results.

**Key insight**: The chat interface is the UI; the workflow engine is the brain running behind it.

---

## What This Enables

From any channel (webOS chat, WhatsApp, email):

```
You: "Start a new feature-dev workflow to add OAuth authentication to myproject"

[Workflow spawns]
Agent 1 (Planner): Breaks into 7 stories
Agent 2 (Developer): Implements story 1
Agent 3 (Verifier): Checks story 1 against acceptance criteria
Agent 4 (Tester): Writes and runs tests
[... cycles through all stories ...]
Agent 5 (Reviewer): Final code review

You: "What's the status of the OAuth workflow?"
Agent: "Workflow OAuth-auth is running: 3/7 stories implemented, 2 verified, 1 tested"
```

For bug fixes:
```
You: "The login form crashes when I enter an email with a '+' character"
Agent: "Starting bug-fix workflow. Triager is reproducing the issue..."
```

---

## User Experience

### Initiation
- Natural language request from any channel
- Agent detects workflow intent OR user explicitly invokes
- Agent confirms: "Starting feature-dev workflow for [task]. Continue?"
- Workflow runs in background, user gets progress updates

### Monitoring
- Real-time status queries: "How's the OAuth workflow going?"
- Dashboard view (webOS) showing all active workflows
- Automatic notifications on milestone completion

### Intervention
- User can pause/resume workflows
- Can provide input when agent escalates (e.g., "Stuck on story 4 - need clarification")
- Can cancel at any step

### Completion
- Agent summarizes results: "Feature complete. 7 stories implemented, all tests passing. PR ready for review at groups/myproject/pr/3"
- Artifacts available in workspace: code, tests, documentation

---

## Technical Architecture

### Core Components

#### 1. Workflow Definition Format (YAML)
```yaml
id: feature-dev
name: Feature Development Workflow
agents:
  - id: planner
    name: Planning Agent
    persona: |
      You break tasks into implementable stories.
      Each story must have clear acceptance criteria.
    workspace:
      mount: .  # Full access to project
      files:
        AGENTS.md: workflows/feature-dev/agents/planner.md

  - id: developer
    name: Developer Agent
    persona: |
      You implement stories from the plan.
      Write clean, well-documented code.
    workspace:
      mount: .
      files:
        AGENTS.md: workflows/feature-dev/agents/developer.md

steps:
  - id: plan
    agent: planner
    input: |
      Task: {{task}}
      Break this into implementable stories.
      Output format: STORY: [title] | ACCEPTANCE: [criteria]
    expects: "STORY:"
    max_retries: 3
    on_failure: escalate

  - id: implement-story-1
    agent: developer
    input: |
      Story to implement: {{plan.story_1}}
      Acceptance criteria: {{plan.story_1_criteria}}
    expects: "IMPLEMENTATION: complete"
    depends_on: plan
```

#### 2. Workflow Engine (`src/workflow-engine.ts`)
- Parses workflow YAML
- Creates workflow run in database
- Spawns containers for each step
- Passes context between steps via files
- Handles retries and escalation
- Manages parallel/serial execution

#### 3. Workflow State (SQLite extension)
```sql
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  group_id TEXT,
  status TEXT, -- running, paused, completed, failed, escalated
  input TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  step_id TEXT,
  agent_id TEXT,
  status TEXT,
  input TEXT,
  output TEXT,
  retries INTEGER,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);
```

#### 4. Container Orchestration
- Each step = fresh container spawn
- Mount workflow state as input/output
- Agent runs in group's workspace
- Results written to `workflow-output/` directory

#### 5. Progress Broadcasting
- Workflow status updates sent to originating channel
- Real-time via WebSocket (webOS) or message (WhatsApp)
- Agent can query: "Show all active workflows"

---

## File Structure

```
nanoclaw/
├── src/
│   ├── workflow-engine.ts       # Core workflow orchestration
│   ├── workflow-db.ts            # DB operations for workflows
│   └── workflow-router.ts        # Routes workflow-related messages
├── workflows/                    # Built-in workflow definitions
│   ├── feature-dev/
│   │   ├── workflow.yaml
│   │   └── agents/
│   │       ├── planner.md
│   │       ├── developer.md
│   │       ├── verifier.md
│   │       ├── tester.md
│   │       └── reviewer.md
│   ├── bug-fix/
│   │   ├── workflow.yaml
│   │   └── agents/
│   └── security-audit/
│       ├── workflow.yaml
│       └── agents/
├── groups/
│   └── myproject/
│       ├── workflow-output/      # Per-workspace results
│       │   ├── run-abc123/
│       │   │   ├── plan.md
│       │   │   ├── story-1-implementation.ts
│       │   │   └── story-1-test.ts
│       │   └── run-def456/
│       └── CLAUDE.md
└── docs/
    └── WORKFLOW_DOD.md
```

---

## Database Schema Changes

Extend `src/db.ts` with workflow tables:

```typescript
// Workflow runs
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','paused','completed','failed','escalated')),
  input TEXT,
  context TEXT,              -- JSON for passing between steps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX idx_workflow_runs_group ON workflow_runs(group_id);

// Workflow steps
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
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_steps_run ON workflow_steps(run_id);
CREATE INDEX idx_workflow_steps_status ON workflow_steps(status);

// Workflow artifacts (for linking to generated files/PRs)
CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  artifact_type TEXT,         -- 'pr', 'file', 'test_result', etc.
  path TEXT,
  metadata TEXT,              -- JSON for type-specific data
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
```

---

## API Surface (Internal)

### WorkflowEngine class
```typescript
class WorkflowEngine {
  // Load and validate workflow definitions
  loadWorkflow(id: string): Promise<WorkflowDefinition>

  // Start a new workflow run
  startRun(workflowId: string, groupId: string, input: string): Promise<string>

  // Execute a single step
  executeStep(runId: string, stepId: string): Promise<StepResult>

  // Resume a paused/failed run
  resumeRun(runId: string): Promise<void>

  // Pause a running workflow
  pauseRun(runId: string): Promise<void>

  // Cancel a workflow
  cancelRun(runId: string): Promise<void>

  // Query workflow status
  getStatus(runId: string): Promise<WorkflowStatus>

  // List workflows for a group
  listWorkflows(groupId: string): Promise<WorkflowSummary[]>

  // Handle step failure (retry or escalate)
  handleFailure(stepId: string, error: Error): Promise<void>
}
```

### Agent Tools (via MCP server)
Agent can invoke workflows:
```typescript
{
  name: "start_workflow",
  description: "Start a multi-agent workflow",
  inputSchema: {
    type: "object",
    properties: {
      workflow_id: { type: "string" },
      task: { type: "string" }
    }
  }
}

{
  name: "workflow_status",
  description: "Check workflow progress",
  inputSchema: {
    type: "object",
    properties: {
      run_id: { type: "string" }
    }
  }
}

{
  name: "list_workflows",
  description: "List available or active workflows"
}
```

---

## Integration Points

### With Existing NanoClaw

1. **Message Router** (`src/router.ts`)
   - Detect workflow initiation intents
   - Route workflow commands to workflow engine

2. **Container Runner** (`src/container-runner.ts`)
   - Spawns containers for each workflow step
   - Mounts workflow state and workspace

3. **Task Scheduler** (`src/task-scheduler.ts`)
   - Can schedule workflows to run at specific times
   - "Every Monday at 9am, run security-audit on myproject"

4. **IPC** (`src/ipc.ts`)
   - Expose workflow control commands
   - `workflow:start`, `workflow:status`, `workflow:pause`

### With WebOS (Hawaii)

1. **Chat Interface**
   - User types natural language request
   - Agent parses and starts workflow
   - Real-time status updates

2. **Dashboard**
   - View all active workflows
   - See step-by-step progress
   - Access artifacts (PRs, code, tests)

3. **Notifications**
   - Workflow started
   - Milestones reached
   - Workflow completed/failed

---

## Success Criteria

### Must Have (MVP)
- [ ] Workflow definition format (YAML) working
- [ ] At least one built-in workflow (feature-dev OR bug-fix)
- [ ] Workflow engine can spawn agents for each step
- [ ] Context passes between steps correctly
- [ ] SQLite tracks workflow state
- [ ] Agent can start workflow from chat
- [ ] Agent can query workflow status
- [ ] Escalation on step failure (after retries)
- [ ] Artifacts saved to workspace
- [ ] Works with any channel (not WhatsApp-specific)

### Should Have
- [ ] Multiple built-in workflows (feature-dev, bug-fix, security-audit)
- [ ] Parallel step execution (where workflow allows)
- [ ] Pause/resume functionality
- [ ] Progress notifications to originating channel
- [ ] Workflow dashboard in webOS
- [ ] Custom workflow creation (users can write YAML)
- [ ] PR creation integration (for workflows that generate code)

### Could Have
- [ ] Workflow templates (scaffolding)
- [ ] Visual workflow editor
- [ ] Workflow marketplace (shareable workflows)
- [ ] Conditional logic in workflows (if/else branches)
- [ ] Sub-workflows (workflows calling workflows)
- [ ] Workflow versioning

---

## Testing Strategy

1. **Unit Tests**
   - Workflow YAML parser
   - Workflow state transitions
   - Retry logic
   - Escalation conditions

2. **Integration Tests**
   - End-to-end workflow execution
   - Multi-step context passing
   - Database persistence
   - Container spawning

3. **Manual Tests**
   - Run feature-dev on a real project
   - Verify generated code quality
   - Test escalation scenarios
   - Test pausing/resuming

---

## Open Questions

1. **Context Passing Format**: JSON files vs. SQLite vs. both?
2. **Step Timeout**: How long before a step is considered stuck?
3. **Parallel Execution**: Which steps can run in parallel? How to coordinate?
4. **Workflow Distribution**: How will users share custom workflows?
5. **Workflow Security**: How to validate workflow YAML is safe?
6. **Resource Limits**: Max concurrent workflows? Max steps per workflow?

---

## Implementation Phases

### Phase 1: Core Engine (Foundation)
- Workflow YAML format
- WorkflowEngine class
- Database schema
- Single-step execution (proof of concept)

### Phase 2: Multi-Step Workflows
- Sequential step execution
- Context passing between steps
- Retry logic
- State persistence

### Phase 3: Built-in Workflows
- feature-dev workflow (7 agents)
- bug-fix workflow (6 agents)
- Agent personas for each

### Phase 4: Integration
- Message router integration
- Agent tools for workflow control
- Channel-agnostic status updates
- WebOS dashboard

### Phase 5: Polish
- Pause/resume
- Progress notifications
- Error handling
- Documentation

---

## Related Work

- **Antfarm**: https://github.com/snarktank/antfarm - Inspiration for workflow format
- **Ralph**: https://github.com/snarktank/ralph - Fresh context pattern
- **LangChain LangGraph**: Similar concept, but heavier weight

---

## Notes

- This system respects NanoClaw's philosophy: small, understandable, secure
- Workflows are just YAML + Markdown - no magic
- Each step runs in a fresh container (isolation)
- Memory is file-based (git-friendly)
- No external dependencies beyond what NanoClaw already has
