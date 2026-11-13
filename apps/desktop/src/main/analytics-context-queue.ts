import { randomUUID } from 'node:crypto';
import { acceptIdentityContext, type AnalyticsIdentityContext } from '@waypoint/analytics-policy';
import type { ClosedBetaEvent } from '../shared/analytics-allowlist';

export interface MainAnalyticsQueuedEvent {
  event: ClosedBetaEvent;
  properties?: Record<string, unknown>;
  capturedAt?: Date;
}

interface MainAnalyticsContextQueueOptions {
  emit(event: MainAnalyticsQueuedEvent, context: AnalyticsIdentityContext): void;
  deadlineMs?: number;
  fallbackFactory?: () => AnalyticsIdentityContext;
  scheduleDeadline?: (callback: () => void, delayMs: number) => unknown;
  cancelDeadline?: (handle: unknown) => void;
}

export class MainAnalyticsContextQueue {
  private readonly emit: MainAnalyticsContextQueueOptions['emit'];
  private readonly deadlineMs: number;
  private readonly fallbackFactory: () => AnalyticsIdentityContext;
  private readonly scheduleDeadline: NonNullable<
    MainAnalyticsContextQueueOptions['scheduleDeadline']
  >;
  private readonly cancelDeadline: NonNullable<MainAnalyticsContextQueueOptions['cancelDeadline']>;
  private enabled = false;
  private context: AnalyticsIdentityContext | null = null;
  private fallbackContext: AnalyticsIdentityContext | null = null;
  private queue: MainAnalyticsQueuedEvent[] = [];
  private deadlineHandle: unknown = null;
  private deadlineExpired = false;

  constructor(options: MainAnalyticsContextQueueOptions) {
    this.emit = options.emit;
    this.deadlineMs = options.deadlineMs ?? 5_000;
    this.fallbackFactory = options.fallbackFactory ?? createFallbackContext;
    this.scheduleDeadline =
      options.scheduleDeadline ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer;
      });
    this.cancelDeadline =
      options.cancelDeadline ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  setConsent(enabled: boolean): void {
    if (!enabled) {
      this.enabled = false;
      this.context = null;
      this.fallbackContext = null;
      this.queue = [];
      this.deadlineExpired = false;
      this.clearDeadline();
      return;
    }

    if (this.enabled) return;
    this.enabled = true;
    this.deadlineExpired = false;
    this.fallbackContext = null;
    this.startDeadline();
  }

  offer(event: MainAnalyticsQueuedEvent): void {
    if (!this.enabled) return;

    if (this.context) {
      this.emit(event, this.context);
      return;
    }

    if (this.deadlineExpired) {
      if (this.fallbackContext) this.emit(event, this.fallbackContext);
      return;
    }

    this.queue.push(event);
  }

  syncContext(incoming: AnalyticsIdentityContext): boolean {
    if (!this.enabled) return false;
    const accepted = acceptIdentityContext(this.context, incoming);
    if (!accepted) return false;

    this.context = accepted;
    this.clearDeadline();
    const queued = this.queue;
    this.queue = [];
    for (const event of queued) this.emit(event, accepted);
    return true;
  }

  currentContext(): AnalyticsIdentityContext | null {
    return this.context ? { ...this.context } : null;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  flushPendingWithFallback(): void {
    if (!this.enabled || this.context || this.deadlineExpired) return;
    this.clearDeadline();
    this.expireDeadline();
  }

  diagnostics(): { overflowDrops: number; deadlineDrops: number } {
    return { overflowDrops: 0, deadlineDrops: 0 };
  }

  private startDeadline(): void {
    this.clearDeadline();
    this.deadlineHandle = this.scheduleDeadline(() => this.expireDeadline(), this.deadlineMs);
  }

  private expireDeadline(): void {
    this.deadlineHandle = null;
    if (!this.enabled || this.context) return;

    this.deadlineExpired = true;
    this.fallbackContext = this.fallbackFactory();
    const queued = this.queue;
    this.queue = [];
    for (const event of queued) this.emit(event, this.fallbackContext);
  }

  private clearDeadline(): void {
    if (this.deadlineHandle === null) return;
    this.cancelDeadline(this.deadlineHandle);
    this.deadlineHandle = null;
  }
}

function createFallbackContext(): AnalyticsIdentityContext {
  return {
    distinctId: randomUUID(),
    sessionId: randomUUID(),
    kind: 'fallback',
    generation: 0,
  };
}
