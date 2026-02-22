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
