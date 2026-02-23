/**
 * Validation Utilities for NanoClaw
 * Input validation, sanitization, and security checks
 */

import { logger } from '../logger.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate JID format (WhatsApp or nanoclaw format)
 */
export function validateJid(jid: string): ValidationResult {
  const errors: string[] = [];

  if (!jid || typeof jid !== 'string') {
    errors.push('JID is required and must be a string');
    return { valid: false, errors };
  }

  // Check for path traversal attempts
  if (jid.includes('..') || jid.includes('/') || jid.includes('\\')) {
    errors.push('JID contains invalid characters');
    logger.warn({ jid }, 'Path traversal attempt detected in JID');
  }

  // Valid formats:
  // - WhatsApp group: 120363422227220717@g.us
  // - WhatsApp user: 1234567890@s.whatsapp.net
  // - Nanoclaw agent: agent@nanoclaw.local
  const validPatterns = [
    /^\d+@g\.us$/,
    /^\d+@s\.whatsapp\.net$/,
    /^[a-zA-Z0-9_-]+@nanoclaw\.local$/,
  ];

  const isValid = validPatterns.some((pattern) => pattern.test(jid));
  if (!isValid) {
    errors.push(`JID format is invalid: ${jid}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate file path (prevent path traversal)
 */
export function validateFilePath(filePath: string, basePath: string): ValidationResult {
  const errors: string[] = [];

  if (!filePath || typeof filePath !== 'string') {
    errors.push('File path is required');
    return { valid: false, errors };
  }

  // Normalize paths
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedBase = basePath.replace(/\\/g, '/');

  // Check for path traversal patterns
  const dangerousPatterns = ['../', '..\\', '\0', '\n', '\r'];
  for (const pattern of dangerousPatterns) {
    if (normalizedPath.includes(pattern)) {
      errors.push(`File path contains dangerous pattern: ${pattern}`);
      logger.warn({ filePath, pattern }, 'Path traversal attempt detected');
    }
  }

  // Resolve and check if within base path
  try {
    const resolved = require('path').resolve(normalizedBase, normalizedPath);
    if (!resolved.startsWith(normalizedBase)) {
      errors.push('File path escapes base directory');
      logger.warn({ filePath, basePath, resolved }, 'Path escapes base directory');
    }
  } catch (error) {
    errors.push('Invalid file path');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate prompt content
 */
export function validatePrompt(prompt: string): ValidationResult {
  const errors: string[] = [];

  if (!prompt || typeof prompt !== 'string') {
    errors.push('Prompt is required and must be a string');
    return { valid: false, errors };
  }

  // Check for excessively long prompts
  if (prompt.length > 100000) {
    errors.push('Prompt exceeds maximum length of 100,000 characters');
  }

  // Check for null bytes
  if (prompt.includes('\0')) {
    errors.push('Prompt contains null bytes');
  }

  // Check for control characters (except common whitespace)
  const hasControlChars = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(prompt);
  if (hasControlChars) {
    errors.push('Prompt contains invalid control characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate task name
 */
export function validateTaskName(name: string): ValidationResult {
  const errors: string[] = [];

  if (!name || typeof name !== 'string') {
    errors.push('Task name is required');
    return { valid: false, errors };
  }

  // Length check
  if (name.length > 200) {
    errors.push('Task name exceeds maximum length of 200 characters');
  }

  // Character check
  if (!/^[\w\s\-.,!?()]+$/.test(name)) {
    errors.push('Task name contains invalid characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate cron expression
 */
export function validateCronExpression(expression: string): ValidationResult {
  const errors: string[] = [];

  if (!expression || typeof expression !== 'string') {
    errors.push('Cron expression is required');
    return { valid: false, errors };
  }

  // Basic format check (5 or 6 fields)
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) {
    errors.push('Cron expression must have 5 or 6 fields');
    return { valid: false, errors };
  }

  // Try to parse with cron-parser
  try {
    const { CronExpressionParser } = require('cron-parser');
    CronExpressionParser.parse(expression);
  } catch (error) {
    errors.push(`Invalid cron expression: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate interval string (e.g., "60000" for milliseconds)
 */
export function validateInterval(interval: string): ValidationResult {
  const errors: string[] = [];

  if (!interval || typeof interval !== 'string') {
    errors.push('Interval is required');
    return { valid: false, errors };
  }

  const ms = parseInt(interval, 10);

  if (isNaN(ms)) {
    errors.push('Interval must be a valid number');
    return { valid: false, errors };
  }

  if (ms < 1000) {
    errors.push('Interval must be at least 1000ms (1 second)');
  }

  if (ms > 365 * 24 * 60 * 60 * 1000) {
    errors.push('Interval cannot exceed 1 year');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate agent folder name
 */
export function validateAgentFolder(folder: string): ValidationResult {
  const errors: string[] = [];

  if (!folder || typeof folder !== 'string') {
    errors.push('Agent folder is required');
    return { valid: false, errors };
  }

  // Must be alphanumeric with underscores/dashes
  if (!/^[a-zA-Z0-9_-]+$/.test(folder)) {
    errors.push('Agent folder must contain only alphanumeric characters, underscores, and dashes');
  }

  // Length check
  if (folder.length > 50) {
    errors.push('Agent folder name exceeds maximum length of 50 characters');
  }

  // Reserved names
  const reservedNames = ['admin', 'api', 'system', 'config', 'data', 'logs', 'tmp'];
  if (reservedNames.includes(folder.toLowerCase())) {
    errors.push(`Agent folder name '${folder}' is reserved`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Sanitize string for safe logging (remove sensitive data)
 */
export function sanitizeForLogging(input: string, maxLength: number = 200): string {
  if (!input) return '';

  // Truncate
  let result = input.length > maxLength ? input.slice(0, maxLength) + '...' : input;

  // Remove potential sensitive patterns
  const sensitivePatterns = [
    /sk-[a-zA-Z0-9]{20,}/g, // API keys
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Emails
    /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, // Credit card numbers
    /password[=:]\s*\S+/gi, // Password in config
    /token[=:]\s*\S+/gi, // Tokens
  ];

  for (const pattern of sensitivePatterns) {
    result = result.replace(pattern, '[REDACTED]');
  }

  return result;
}

/**
 * Validate JSON string
 */
export function validateJson(input: string): ValidationResult {
  const errors: string[] = [];

  if (!input || typeof input !== 'string') {
    errors.push('Input is required');
    return { valid: false, errors };
  }

  try {
    JSON.parse(input);
  } catch (error) {
    errors.push(`Invalid JSON: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate message content for WhatsApp
 */
export function validateMessageContent(content: string): ValidationResult {
  const errors: string[] = [];

  if (!content || typeof content !== 'string') {
    errors.push('Message content is required');
    return { valid: false, errors };
  }

  // WhatsApp has a 4096 character limit per message
  if (content.length > 4096) {
    errors.push('Message exceeds WhatsApp limit of 4096 characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate WebSocket message size
 */
export function validateMessageSize(data: string, maxSizeBytes: number = 1048576): ValidationResult {
  const errors: string[] = [];

  const sizeBytes = Buffer.byteLength(data, 'utf8');

  if (sizeBytes > maxSizeBytes) {
    errors.push(`Message size ${sizeBytes} exceeds maximum ${maxSizeBytes} bytes`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate database query parameters to prevent injection
 */
export function validateDbIdentifier(identifier: string): ValidationResult {
  const errors: string[] = [];

  if (!identifier || typeof identifier !== 'string') {
    errors.push('Identifier is required');
    return { valid: false, errors };
  }

  // Only allow alphanumeric, underscore, and hyphen
  if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
    errors.push('Identifier contains invalid characters (only alphanumeric, underscore, hyphen allowed)');
  }

  // Length check
  if (identifier.length > 64) {
    errors.push('Identifier exceeds maximum length of 64 characters');
  }

  // Check for SQL keywords (basic protection)
  const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'UNION', 'WHERE', 'FROM'];
  const upperId = identifier.toUpperCase();
  for (const keyword of sqlKeywords) {
    if (upperId.includes(keyword)) {
      errors.push(`Identifier contains SQL keyword: ${keyword}`);
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate container name format
 */
export function validateContainerName(name: string): ValidationResult {
  const errors: string[] = [];

  if (!name || typeof name !== 'string') {
    errors.push('Container name is required');
    return { valid: false, errors };
  }

  // Docker container name rules
  // Must be [a-zA-Z0-9][a-zA-Z0-9_.-]
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    errors.push('Container name must start with alphanumeric and contain only alphanumeric, underscore, dot, or hyphen');
  }

  if (name.length > 63) {
    errors.push('Container name exceeds 63 character limit');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate session key format
 */
export function validateSessionKey(sessionKey: string): ValidationResult {
  const errors: string[] = [];

  if (!sessionKey || typeof sessionKey !== 'string') {
    errors.push('Session key is required');
    return { valid: false, errors };
  }

  // Expected format: agent:{folder}:{context} or agent:{folder}:web:{id}
  const validPatterns = [
    /^agent:[a-zA-Z0-9_-]+:main$/,
    /^agent:[a-zA-Z0-9_-]+:web:[a-zA-Z0-9-]+$/,
    /^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/,
  ];

  const isValid = validPatterns.some((pattern) => pattern.test(sessionKey));
  if (!isValid) {
    errors.push(`Session key format invalid: ${sessionKey}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate timeout value
 */
export function validateTimeout(timeoutMs: number, minMs: number = 1000, maxMs: number = 86400000): ValidationResult {
  const errors: string[] = [];

  if (typeof timeoutMs !== 'number' || isNaN(timeoutMs)) {
    errors.push('Timeout must be a valid number');
    return { valid: false, errors };
  }

  if (timeoutMs < minMs) {
    errors.push(`Timeout ${timeoutMs}ms is below minimum ${minMs}ms`);
  }

  if (timeoutMs > maxMs) {
    errors.push(`Timeout ${timeoutMs}ms exceeds maximum ${maxMs}ms`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate workflow ID format
 */
export function validateWorkflowId(workflowId: string): ValidationResult {
  const errors: string[] = [];

  if (!workflowId || typeof workflowId !== 'string') {
    errors.push('Workflow ID is required');
    return { valid: false, errors };
  }

  // Allow alphanumeric, underscore, hyphen, and forward slash (for namespacing)
  if (!/^[a-zA-Z0-9_/-]+$/.test(workflowId)) {
    errors.push('Workflow ID contains invalid characters');
  }

  if (workflowId.length > 128) {
    errors.push('Workflow ID exceeds maximum length of 128 characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Sanitize filename for safe filesystem operations
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return '';

  // Remove path separators and null bytes
  let sanitized = filename.replace(/[\/\\:\x00]/g, '_');

  // Remove leading dots (hidden files)
  sanitized = sanitized.replace(/^\.+/, '');

  // Limit length
  if (sanitized.length > 255) {
    const ext = sanitized.split('.').pop() || '';
    const baseName = sanitized.slice(0, -(ext.length + 1));
    sanitized = baseName.slice(0, 250 - ext.length) + '.' + ext;
  }

  return sanitized || 'unnamed';
}

/**
 * Validate and sanitize search query for FTS5
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query) return '';

  // Remove newlines and control characters
  let sanitized = query.replace(/[\r\n\t\x00-\x1f]/g, ' ');

  // Escape FTS5 special characters by wrapping in quotes
  // Special chars: - " " + * ( ) : [ ] ^ & ;
  sanitized = sanitized.replace(/([\-"\+\*\(\)\:\[\]\^&;])/g, '"$1"');

  // Limit length
  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 500);
  }

  return sanitized.trim();
}

/**
 * Validate port number
 */
export function validatePort(port: number | string): ValidationResult {
  const errors: string[] = [];

  const portNum = typeof port === 'string' ? parseInt(port, 10) : port;

  if (isNaN(portNum)) {
    errors.push('Port must be a valid number');
    return { valid: false, errors };
  }

  // Allow user ports (1024-65535)
  if (portNum < 1024) {
    errors.push('Port must be 1024 or higher (user ports)');
  }

  if (portNum > 65535) {
    errors.push('Port cannot exceed 65535');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate npm command
 */
export function validateNpmCommand(command: string): ValidationResult {
  const errors: string[] = [];

  if (!command || typeof command !== 'string') {
    errors.push('Command is required');
    return { valid: false, errors };
  }

  // Check for shell operators that could allow command injection
  const shellOperators = ['&&', '||', ';', '|', '`', '$(', '>', '>>', '<'];
  for (const op of shellOperators) {
    if (command.includes(op)) {
      errors.push(`Command contains forbidden shell operator: ${op}`);
      break;
    }
  }

  // Check for sudo/su (could be part of script name, so check word boundaries)
  const sudoPattern = /\b(sudo|su)\b/i;
  if (sudoPattern.test(command)) {
    errors.push('Command cannot contain sudo or su');
  }

  // Only allow npm, yarn, pnpm, npx commands at the start
  const allowedStarts = ['npm ', 'npm\t', 'yarn ', 'yarn\t', 'pnpm ', 'pnpm\t', 'npx ', 'npx\t'];
  const trimmed = command.trim();
  const startsWithAllowed = allowedStarts.some(start =>
    trimmed.toLowerCase().startsWith(start.toLowerCase())
  );

  if (!startsWithAllowed) {
    errors.push('Only npm, yarn, pnpm, and npx commands are allowed');
  }

  // Length check
  if (command.length > 500) {
    errors.push('Command exceeds maximum length of 500 characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate project path within workspace
 */
export function validateProjectPath(projectPath: string, workspacePath: string): ValidationResult {
  const errors: string[] = [];

  if (!projectPath || typeof projectPath !== 'string') {
    errors.push('Project path is required');
    return { valid: false, errors };
  }

  // First validate as a file path
  const pathValidation = validateFilePath(projectPath, workspacePath);
  if (!pathValidation.valid) {
    return pathValidation;
  }

  // Check that it's a directory-like path (no file extension requirement)
  // This is more permissive than file path validation

  return { valid: errors.length === 0, errors };
}

/**
 * Validate hex color
 */
export function validateHexColor(color: string): ValidationResult {
  const errors: string[] = [];

  if (!color || typeof color !== 'string') {
    errors.push('Color is required');
    return { valid: false, errors };
  }

  // Allow #RGB, #RRGGBB, #RGBA, #RRGGBBAA
  const hexPattern = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
  if (!hexPattern.test(color)) {
    errors.push('Color must be a valid hex color (e.g., #FF0000 or #F00)');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate URL
 */
export function validateUrl(url: string, allowedProtocols: string[] = ['http:', 'https:']): ValidationResult {
  const errors: string[] = [];

  if (!url || typeof url !== 'string') {
    errors.push('URL is required');
    return { valid: false, errors };
  }

  try {
    const parsed = new URL(url);

    if (!allowedProtocols.includes(parsed.protocol)) {
      errors.push(`URL protocol must be one of: ${allowedProtocols.join(', ')}`);
    }

    // Check for dangerous patterns
    if (url.includes('javascript:')) {
      errors.push('URL cannot contain javascript:');
    }
  } catch {
    errors.push('Invalid URL format');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate email format
 */
export function validateEmail(email: string): ValidationResult {
  const errors: string[] = [];

  if (!email || typeof email !== 'string') {
    errors.push('Email is required');
    return { valid: false, errors };
  }

  // Basic email pattern
  const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailPattern.test(email)) {
    errors.push('Invalid email format');
  }

  if (email.length > 254) {
    errors.push('Email exceeds maximum length of 254 characters');
  }

  return { valid: errors.length === 0, errors };
}
