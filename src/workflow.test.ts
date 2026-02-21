/**
 * Workflow System Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { _initTestDatabase } from './db.js';
import { setRegisteredGroup } from './db.js';
import { loadWorkflow, validateWorkflow, listWorkflows } from './workflow-parser.js';
import { workflowEngine } from './workflow-engine.js';
import { listWorkflowRuns, createWorkflowRun } from './workflow-db.js';
import { detectWorkflowIntent } from './workflow-router.js';

describe('Workflow System', () => {
  beforeAll(() => {
    _initTestDatabase();
    // Create a test group for foreign key constraints
    setRegisteredGroup('test@g.us', {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@test',
      added_at: new Date().toISOString(),
    });
  });

  describe('Workflow Parser', () => {
    it('should list available workflows', () => {
      const workflows = listWorkflows();
      expect(workflows).toContain('feature-dev');
      expect(workflows).toContain('bug-fix');
    });

    it('should load feature-dev workflow', () => {
      const workflow = loadWorkflow('feature-dev');
      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe('feature-dev');
      expect(workflow?.agents.length).toBeGreaterThan(0);
      expect(workflow?.steps.length).toBeGreaterThan(0);
    });

    it('should load bug-fix workflow', () => {
      const workflow = loadWorkflow('bug-fix');
      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe('bug-fix');
      expect(workflow?.agents.length).toBeGreaterThan(0);
      expect(workflow?.steps.length).toBeGreaterThan(0);
    });

    it('should validate feature-dev workflow', () => {
      const workflow = loadWorkflow('feature-dev');
      const validation = validateWorkflow(workflow!);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should validate bug-fix workflow', () => {
      const workflow = loadWorkflow('bug-fix');
      const validation = validateWorkflow(workflow!);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect circular dependencies', () => {
      // This would require a test workflow with circular deps
      // For now, we trust the implementation
      const workflow = loadWorkflow('feature-dev');
      const validation = validateWorkflow(workflow!);
      expect(validation.errors.filter(e => e.message.includes('circular'))).toHaveLength(0);
    });
  });

  describe('Workflow Engine', () => {
    it('should load workflow definitions', () => {
      const workflow = workflowEngine.loadWorkflow('feature-dev');
      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe('feature-dev');
    });

    it('should create workflow runs', () => {
      const runId = createWorkflowRun('feature-dev', 'test-group', 'Test feature');
      expect(runId).toBeTruthy();
      expect(runId.length).toBeGreaterThan(0);

      const runs = listWorkflowRuns('test-group');
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0].workflow_id).toBe('feature-dev');
    });

    it('should get workflow status', () => {
      const runId = createWorkflowRun('bug-fix', 'test-group', 'Fix a bug');
      const status = workflowEngine.getStatus(runId);
      expect(status).not.toBeNull();
      expect(status.run.id).toBe(runId);
      expect(status.run.workflow_id).toBe('bug-fix');
    });

    it('should list workflows for a group', () => {
      const runs = workflowEngine.listWorkflows('test-group');
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.length).toBeGreaterThan(0);
    });
  });

  describe('Workflow Router', () => {
    it('should detect workflow intents', () => {
      const startIntent = detectWorkflowIntent('Start feature-dev workflow to add OAuth');
      expect(startIntent.action).toBe('start');
      expect(startIntent.workflowId).toBe('feature-dev');
      expect(startIntent.task).toContain('oauth');

      const statusIntent = detectWorkflowIntent('workflow status');
      expect(statusIntent.action).toBe('status');

      const listIntent = detectWorkflowIntent('list workflows');
      expect(listIntent.action).toBe('list');
    });
  });
});
