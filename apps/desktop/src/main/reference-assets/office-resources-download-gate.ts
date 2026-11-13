import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type { HostedReferenceBodyReadGate } from './hosted-reference-transport';

const MAX_RESERVATION_BYTES = 4 * 1024 * 1024;

interface OfficeResourcesGateResponseV1 {
  readonly ok: true;
  readonly bytes: number;
}

interface PendingResponse {
  readonly expectedBytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface OfficeResourcesDownloadGateOptions {
  readonly policyPath?: string;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
}

export class OfficeResourcesDownloadGate implements HostedReferenceBodyReadGate {
  private readonly policyPath: string;
  private readonly command: string;
  private readonly commandArgs: readonly string[];
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private pendingResponse: PendingResponse | null = null;
  private stderrTail = '';
  private queueTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private policyRequired = false;

  constructor(options: OfficeResourcesDownloadGateOptions = {}) {
    this.policyPath = options.policyPath ?? join(homedir(), '.config', 'office-resources.json');
    this.command = options.command ?? 'office-resources';
    this.commandArgs = options.commandArgs ?? ['gate'];
  }

  reserve(bytes: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RESERVATION_BYTES) {
      return Promise.reject(new Error('Hosted reference reservation size is invalid.'));
    }
    this.policyRequired = this.policyRequired || existsSync(this.policyPath);
    if (!this.policyRequired) return Promise.resolve();
    if (this.disposed) {
      return Promise.reject(this.unavailableError('the limiter client has been disposed'));
    }
    const operation = this.queueTail.then(() => this.reserveOne(bytes, signal));
    this.queueTail = operation.catch(() => undefined);
    return operation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(this.unavailableError('the application is shutting down'));
    this.lines?.close();
    this.lines = null;
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin.end();
      if (child.exitCode === null && !child.killed) child.kill();
    }
  }

  private async reserveOne(bytes: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancellationError(signal.reason);
    const child = await this.ensureProcess();
    if (signal.aborted) throw cancellationError(signal.reason);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      if (this.pendingResponse) {
        rejectPromise(this.unavailableError('the limiter protocol received overlapping requests'));
        return;
      }
      this.pendingResponse = {
        expectedBytes: bytes,
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      try {
        child.stdin.write(`${JSON.stringify({ bytes })}\n`, (error) => {
          if (!error) return;
          this.rejectPending(this.unavailableError(error.message));
        });
      } catch (error) {
        this.rejectPending(
          this.unavailableError(error instanceof Error ? error.message : String(error))
        );
      }
    });
    if (signal.aborted) throw cancellationError(signal.reason);
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    const current = this.process;
    if (current && current.exitCode === null && !current.killed) return current;
    if (this.disposed) throw this.unavailableError('the limiter client has been disposed');

    this.stderrTail = '';
    const child = spawn(this.command, [...this.commandArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines = lines;
    lines.on('line', (line) => this.acceptResponse(line));
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (!this.disposed) {
        const detail = this.stderrTail.trim() || `exit=${String(code)} signal=${String(signal)}`;
        this.rejectPending(this.unavailableError(detail));
      }
    });
    child.on('error', (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.rejectPending(this.unavailableError(error.message));
    });

    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onSpawn = (): void => {
          child.removeListener('error', onError);
          resolvePromise();
        };
        const onError = (error: Error): void => {
          child.removeListener('spawn', onSpawn);
          rejectPromise(error);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
    } catch (error) {
      if (this.process === child) this.process = null;
      lines.close();
      throw this.unavailableError(error instanceof Error ? error.message : String(error));
    }
    return child;
  }

  private acceptResponse(line: string): void {
    const pending = this.pendingResponse;
    if (!pending) {
      this.disposeForProtocolFailure('the limiter returned an unsolicited response');
      return;
    }
    let response: unknown;
    try {
      response = JSON.parse(line) as unknown;
    } catch {
      this.disposeForProtocolFailure('the limiter returned invalid JSON');
      return;
    }
    if (!isSuccessfulResponse(response, pending.expectedBytes)) {
      const detail =
        response && typeof response === 'object' && 'error' in response
          ? String(response.error)
          : 'the limiter returned an invalid reservation receipt';
      this.rejectPending(this.unavailableError(detail));
      return;
    }
    this.pendingResponse = null;
    pending.resolve();
  }

  private disposeForProtocolFailure(detail: string): void {
    this.rejectPending(this.unavailableError(detail));
    const child = this.process;
    this.process = null;
    this.lines?.close();
    this.lines = null;
    if (child && child.exitCode === null && !child.killed) child.kill();
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingResponse;
    this.pendingResponse = null;
    pending?.reject(error);
  }

  private unavailableError(detail: string): Error {
    return new Error(
      `Hosted reference transfer was blocked because the shared office download limiter is unavailable: ${detail}.`
    );
  }
}

function isSuccessfulResponse(
  value: unknown,
  expectedBytes: number
): value is OfficeResourcesGateResponseV1 {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    value.ok === true &&
    'bytes' in value &&
    value.bytes === expectedBytes
  );
}

function cancellationError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Hosted reference download was cancelled.');
  error.name = 'AbortError';
  return error;
}
