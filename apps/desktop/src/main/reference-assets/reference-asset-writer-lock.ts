import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

const REFERENCE_ASSET_WRITER_LOCK_FILE = '.reference-assets.ensure.lock';
const MAX_HELPER_STDERR_BYTES = 64 * 1024;
export const REFERENCE_ASSET_LOCK_RESPONSE_SLO_MS = 5_000;

export interface ReferenceAssetLockHelper {
  readonly executable: string;
  readonly argsPrefix?: readonly string[];
  readonly responseTimeoutMs?: number;
}

export interface ReferenceAssetWriterLease {
  assertOwned(): Promise<void>;
  commitPointer(temporaryPath: string, pointerPath: string): Promise<void>;
  acceptReconciledCommit(): Promise<void>;
  release(): Promise<void>;
}

interface ReferenceAssetLockEvent {
  readonly event: 'locked' | 'busy' | 'committed' | 'released';
}

export function referenceAssetWriterLockPath(assemblyCacheRoot: string): string {
  return join(assemblyCacheRoot, REFERENCE_ASSET_WRITER_LOCK_FILE);
}

export async function acquireReferenceAssetWriterLock(
  assemblyCacheRoot: string,
  helper: string | ReferenceAssetLockHelper
): Promise<ReferenceAssetWriterLease> {
  await mkdir(assemblyCacheRoot, { recursive: true });
  const lockPath = referenceAssetWriterLockPath(assemblyCacheRoot);
  const resolvedHelper =
    typeof helper === 'string' ? { executable: helper, argsPrefix: [] } : helper;
  const responseTimeoutMs =
    'responseTimeoutMs' in resolvedHelper && resolvedHelper.responseTimeoutMs !== undefined
      ? resolvedHelper.responseTimeoutMs
      : REFERENCE_ASSET_LOCK_RESPONSE_SLO_MS;
  if (!Number.isFinite(responseTimeoutMs) || responseTimeoutMs <= 0) {
    throw new Error('Reference asset lock helper response timeout must be positive.');
  }
  const child = spawn(
    resolvedHelper.executable,
    [...(resolvedHelper.argsPrefix ?? []), 'reference-asset-lock', '--lock-path', lockPath],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const protocol = new ReferenceAssetLockProtocol(child, responseTimeoutMs);

  try {
    const admission = await protocol.nextEvent('startup');
    if (admission.event === 'busy') {
      throw new Error('Reference asset refresh is already running in another process.');
    }
    if (admission.event !== 'locked') {
      throw new Error(`Reference asset lock helper returned ${admission.event} before admission.`);
    }
  } catch (error) {
    protocol.abort();
    throw error;
  }

  let state: 'owned' | 'commit-ambiguous' | 'released' = 'owned';
  const assertOwned = async (): Promise<void> => {
    if (state !== 'owned' || child.exitCode !== null || child.killed || child.stdin.destroyed) {
      throw new Error(`Reference asset refresh lock ownership was lost.${protocol.stderrSuffix()}`);
    }
  };
  const abortLease = (): void => {
    state = 'released';
    protocol.abort();
  };

  return {
    assertOwned,
    async commitPointer(temporaryPath: string, pointerPath: string): Promise<void> {
      let commandSent = false;
      try {
        await assertOwned();
        commandSent = true;
        await protocol.writeCommand(
          {
            command: 'commit-pointer',
            temporary_path: temporaryPath,
            pointer_path: pointerPath,
          },
          'pointer commit command write'
        );
        const result = await protocol.nextEvent('pointer commit');
        if (result.event !== 'committed') {
          throw new Error(
            `Reference asset lock helper returned ${result.event} during publication.`
          );
        }
      } catch (error) {
        if (commandSent) {
          state = 'commit-ambiguous';
          protocol.abort();
        } else {
          abortLease();
        }
        throw error;
      }
    },
    async acceptReconciledCommit(): Promise<void> {
      if (state === 'commit-ambiguous') {
        state = 'released';
        return;
      }
      if (state === 'released') {
        throw new Error('Reference asset refresh lock was already released.');
      }
      try {
        await assertOwned();
        child.stdin.end();
        const exitCode = await protocol.waitForExit('reconciled commit exit');
        if (exitCode !== 0) {
          throw new Error(
            `Reference asset lock helper exited with code ${String(exitCode)}.${protocol.stderrSuffix()}`
          );
        }
        state = 'released';
        protocol.dispose();
      } catch (error) {
        abortLease();
        throw error;
      }
    },
    async release(): Promise<void> {
      if (state === 'released') return;
      if (state === 'commit-ambiguous') {
        state = 'released';
        return;
      }
      try {
        await assertOwned();
        await protocol.writeCommand({ command: 'release' }, 'release command write');
        const result = await protocol.nextEvent('release');
        if (result.event !== 'released') {
          throw new Error(`Reference asset lock helper returned ${result.event} during release.`);
        }
        child.stdin.end();
        const exitCode = await protocol.waitForExit('release exit');
        if (exitCode !== 0) {
          throw new Error(
            `Reference asset lock helper exited with code ${String(exitCode)}.${protocol.stderrSuffix()}`
          );
        }
        state = 'released';
        protocol.dispose();
      } catch (error) {
        abortLease();
        throw error;
      } finally {
        if (state !== 'released') abortLease();
      }
    },
  };
}

class ReferenceAssetLockProtocol {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #iterator: AsyncIterableIterator<string>;
  readonly #responseTimeoutMs: number;
  readonly #childError: Promise<Error>;
  #stderr = '';
  #disposed = false;

  constructor(child: ChildProcessWithoutNullStreams, responseTimeoutMs: number) {
    this.#child = child;
    this.#responseTimeoutMs = responseTimeoutMs;
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#iterator = this.#lines[Symbol.asyncIterator]();
    this.#childError = new Promise((resolve) => {
      child.once('error', resolve);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_HELPER_STDERR_BYTES);
    });
  }

  async nextEvent(operation: string): Promise<ReferenceAssetLockEvent> {
    const next = await this.#withDeadline(this.#iterator.next(), operation);
    if (next.done) {
      throw new Error(
        `Reference asset lock helper exited before completing its protocol.${this.stderrSuffix()}`
      );
    }
    const parsed = JSON.parse(next.value) as Record<string, unknown>;
    if (
      parsed.event !== 'locked' &&
      parsed.event !== 'busy' &&
      parsed.event !== 'committed' &&
      parsed.event !== 'released'
    ) {
      throw new Error(`Reference asset lock helper emitted an invalid event: ${next.value}`);
    }
    return { event: parsed.event };
  }

  async writeCommand(command: Readonly<Record<string, unknown>>, operation: string): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.stdin.destroyed) {
      throw new Error(`Reference asset lock helper is unavailable.${this.stderrSuffix()}`);
    }
    await this.#withDeadline(
      new Promise<void>((resolve, reject) => {
        this.#child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
      operation
    );
  }

  async waitForExit(operation: string): Promise<number | null> {
    if (this.#child.exitCode !== null) return this.#child.exitCode;
    return this.#withDeadline(
      new Promise((resolve) => {
        this.#child.once('exit', (code) => resolve(code));
      }),
      operation
    );
  }

  stderrSuffix(): string {
    const stderr = this.#stderr.trim();
    return stderr ? ` Helper stderr: ${stderr}` : '';
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lines.close();
  }

  abort(): void {
    this.dispose();
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    if (this.#child.exitCode === null && !this.#child.killed) {
      this.#child.kill('SIGKILL');
    }
    this.#child.unref();
  }

  async #withDeadline<T>(pending: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Reference asset lock helper ${operation} exceeded the ${this.#responseTimeoutMs} ms response deadline.${this.stderrSuffix()}`
          )
        );
      }, this.#responseTimeoutMs);
      timer.unref?.();
    });
    const childFailure = this.#childError.then((error): never => {
      throw new Error(
        `Reference asset lock helper could not start: ${error.message}.${this.stderrSuffix()}`
      );
    });
    try {
      return await Promise.race([pending, childFailure, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
