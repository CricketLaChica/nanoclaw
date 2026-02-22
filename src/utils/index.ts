/**
 * NanoClaw Utilities Index
 * Re-exports all utility modules
 */

export * from './error-boundary.js';
export * from './validation.js';
export * from './resource-manager.js';

// Re-export commonly used functions for convenience
export {
  withRetry,
  withTimeout,
  CircuitBreaker,
  RateLimiter,
  debounce,
  throttle,
  sleep,
  ok,
  err,
  safeJsonParse,
  // New exports
  gracefulDegradation,
  Bulkhead,
  withTimeoutAndCleanup,
  memoizeWithTTL,
  HealthCheckRegistry,
  type HealthCheckResult,
} from './error-boundary.js';

export {
  validateJid,
  validateFilePath,
  validatePrompt,
  validateTaskName,
  validateCronExpression,
  validateInterval,
  validateAgentFolder,
  validateJson,
  validateMessageContent,
  validateMessageSize,
  sanitizeForLogging,
  // New exports
  validateDbIdentifier,
  validateContainerName,
  validateSessionKey,
  validateTimeout,
  validateWorkflowId,
  sanitizeFilename,
  sanitizeFtsQuery,
} from './validation.js';

export {
  ResourceManager,
  resourceManager,
  // New exports
  getDiskSpaceUsage,
  hasEnoughDiskSpace,
  getMemoryDetails,
  forceGC,
  ResourceGuard,
  resourceGuard,
  type MemoryDetails,
} from './resource-manager.js';
