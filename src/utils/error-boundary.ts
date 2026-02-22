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
