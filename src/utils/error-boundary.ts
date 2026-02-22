/**
 * Error Boundary Utilities for NanoClaw
 * Provides consistent error handling, retries, and circuit breakers
 */

import { logger } from '../logger.js';

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: Error) => boolean;
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxAttempts, delayMs, backoffMultiplier = 2, maxDelayMs = 30000, shouldRetry } = options;
  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        logger.error({ attempt, maxAttempts, error: lastError.message }, 'All retry attempts failed');
        throw lastError;
      }

      if (shouldRetry && !shouldRetry(lastError)) {
        logger.debug({ attempt, error: lastError.message }, 'Non-retryable error, not retrying');
        throw lastError;
      }

      logger.warn(
        { attempt, maxAttempts, delayMs: currentDelay, error: lastError.message },
        'Operation failed, retrying',
      );

      await sleep(currentDelay);
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Circuit breaker for external dependencies
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeoutMs: number = 60000,
    private readonly name: string = 'default',
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure < this.resetTimeoutMs) {
        throw new Error(`Circuit breaker [${this.name}] is open - too many failures`);
      }
      this.state = 'half-open';
      logger.info({ name: this.name }, 'Circuit breaker entering half-open state');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      logger.info({ name: this.name }, 'Circuit breaker recovered, closing');
    }
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'open';
      logger.warn(
        { name: this.name, failures: this.failures, threshold: this.threshold },
        'Circuit breaker opened due to failures',
      );
    }
  }

  getState(): { state: string; failures: number } {
    return { state: this.state, failures: this.failures };
  }
}

/**
 * Wrap async function with error logging
 */
export function withErrorLogging<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  context: string,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error(
        { context, error: error instanceof Error ? error.message : String(error) },
        `Error in ${context}`,
      );
      throw error;
    }
  };
}

/**
 * Timeout wrapper for async operations
 */
export async function withTimeout<T>(
  fn: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out',
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([fn, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Debounce utility
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): (...args: TArgs) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: TArgs) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delayMs);
  };
}

/**
 * Throttle utility
 */
export function throttle<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  limitMs: number,
): (...args: TArgs) => void {
  let inThrottle = false;

  return (...args: TArgs) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limitMs);
    }
  };
}

/**
 * Rate limiter using token bucket algorithm
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRateMs: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  tryAcquire(cost: number = 1): boolean {
    this.refill();

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  async acquire(cost: number = 1): Promise<void> {
    while (!this.tryAcquire(cost)) {
      await sleep(this.refillRateMs);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillRateMs);

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }
}

/**
 * Simple sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Safely parse JSON with error handling
 */
export function safeJsonParse<T>(text: string, defaultValue: T): T {
  try {
    return JSON.parse(text);
  } catch {
    logger.warn({ text: text.slice(0, 100) }, 'Failed to parse JSON, using default');
    return defaultValue;
  }
}

/**
 * Singleton pattern with lazy initialization
 */
export class Singleton<T> {
  private instance: T | null = null;
  private initPromise: Promise<T> | null = null;

  constructor(private readonly init: () => Promise<T>) {}

  async get(): Promise<T> {
    if (this.instance) {
      return this.instance;
    }

    if (!this.initPromise) {
      this.initPromise = this.init();
    }

    this.instance = await this.initPromise;
    return this.instance;
  }

  reset(): void {
    this.instance = null;
    this.initPromise = null;
  }
}

/**
 * Graceful degradation helper - try multiple strategies in order
 */
export async function gracefulDegradation<T>(
  strategies: Array<() => Promise<T>>,
  fallback: T,
  context?: string,
): Promise<T> {
  for (let i = 0; i < strategies.length; i++) {
    try {
      const result = await strategies[i]();
      if (i > 0) {
        logger.info({ strategy: i, context }, 'Graceful degradation: fallback strategy succeeded');
      }
      return result;
    } catch (error) {
      logger.warn(
        { strategy: i, totalStrategies: strategies.length, error, context },
        'Strategy failed, trying next',
      );
    }
  }
  logger.warn({ context }, 'All strategies failed, using fallback');
  return fallback;
}

/**
 * Bulkhead pattern - limit concurrent executions to prevent resource exhaustion
 */
export class Bulkhead {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueSize: number = 100,
    private readonly name: string = 'default',
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check queue limit
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`Bulkhead [${this.name}] queue full (${this.maxQueueSize} items)`);
    }

    // Wait for a slot
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.activeCount++;

    try {
      return await fn();
    } finally {
      this.activeCount--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  getStats(): { active: number; queued: number; available: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      available: Math.max(0, this.maxConcurrent - this.activeCount),
    };
  }
}

/**
 * Timeout with cleanup - ensures cleanup runs even on timeout
 */
export async function withTimeoutAndCleanup<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  cleanup?: () => Promise<void>,
  message = 'Operation timed out',
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${message} after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(controller.signal), timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  } catch (error) {
    // Run cleanup on error
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupError) {
        logger.warn({ cleanupError }, 'Cleanup failed after error');
      }
    }
    throw error;
  }
}

/**
 * Memoize with TTL - cache results with expiration
 */
export function memoizeWithTTL<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  ttlMs: number,
  keyGenerator?: (...args: TArgs) => string,
): (...args: TArgs) => Promise<TResult> {
  const cache = new Map<string, { value: TResult; expires: number }>();

  return async (...args: TArgs): Promise<TResult> => {
    const key = keyGenerator ? keyGenerator(...args) : JSON.stringify(args);
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && cached.expires > now) {
      return cached.value;
    }

    const value = await fn(...args);
    cache.set(key, { value, expires: now + ttlMs });

    // Cleanup expired entries periodically
    if (cache.size > 100) {
      for (const [k, v] of cache) {
        if (v.expires <= now) {
          cache.delete(k);
        }
      }
    }

    return value;
  };
}

/**
 * Health check result type
 */
export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Health check registry - track multiple health checks
 */
export class HealthCheckRegistry {
  private checks = new Map<string, () => Promise<HealthCheckResult>>();

  register(name: string, check: () => Promise<HealthCheckResult>): void {
    this.checks.set(name, check);
  }

  async runAll(): Promise<Record<string, HealthCheckResult>> {
    const results: Record<string, HealthCheckResult> = {};

    await Promise.all(
      Array.from(this.checks.entries()).map(async ([name, check]) => {
        try {
          results[name] = await check();
        } catch (error) {
          results[name] = {
            healthy: false,
            message: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }),
    );

    return results;
  }

  async isHealthy(): Promise<boolean> {
    const results = await this.runAll();
    return Object.values(results).every((r) => r.healthy);
  }
}
