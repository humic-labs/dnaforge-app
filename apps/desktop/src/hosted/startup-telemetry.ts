import type {
  HostedStartupErrorClass,
  HostedStartupObservation,
  HostedStartupResult,
  HostedStartupStep,
} from '../shared/hosted-startup-telemetry';

function errorClass(error: unknown): HostedStartupErrorClass {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    if (error.status >= 500 && error.status <= 599) return 'http_server';
    if (error.status >= 400 && error.status <= 499) return 'http_client';
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timeout';
    if (error.name === 'AbortError') return 'cancelled';
    if (error instanceof TypeError) return 'type_error';
  }
  return 'unknown';
}

export class HostedStartupTrace {
  private step: HostedStartupStep = 'sequence_fonts';
  private readonly startedAt: number;
  private stepStartedAt: number;
  private reported = false;

  constructor(
    private readonly emit: (observation: HostedStartupObservation) => void,
    private readonly now: () => number = () => performance.now(),
    private readonly attemptId = crypto.randomUUID()
  ) {
    this.startedAt = this.now();
    this.stepStartedAt = this.startedAt;
  }

  async run<T>(step: HostedStartupStep, operation: () => T | Promise<T>): Promise<T> {
    this.step = step;
    this.stepStartedAt = this.now();
    return operation();
  }

  report(result: HostedStartupResult, error?: unknown): void {
    if (this.reported) return;
    this.reported = true;
    const now = this.now();
    try {
      this.emit({
        attemptId: this.attemptId,
        step: this.step,
        result,
        errorClass: result === 'failed' ? errorClass(error) : 'none',
        durationMs: Math.min(86_400_000, Math.max(0, Math.round(now - this.startedAt))),
        stepDurationMs: Math.min(86_400_000, Math.max(0, Math.round(now - this.stepStartedAt))),
      });
    } catch (error: unknown) {
      console.warn('[Hosted startup telemetry] Observation could not be recorded', error);
    }
  }
}

export function emitHostedStartupObservation(observation: HostedStartupObservation): void {
  void fetch('/api/telemetry/hosted-startup', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(observation),
    signal: AbortSignal.timeout(8_000),
  })
    .then((response) => {
      if (!response.ok)
        console.warn('[Hosted startup telemetry] Observation was not accepted', response.status);
    })
    .catch((error: unknown) => {
      console.warn('[Hosted startup telemetry] Observation could not be sent', error);
    });
}
