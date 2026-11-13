import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const BROAD_RASTER_SHARD_ENTRY_ENV = 'DNAFORGE_BROAD_RASTER_SHARD_ENTRY';
export const SEARCH_CHROMOSOME_ENTRY_ENV = 'DNAFORGE_SEARCH_CHROMOSOME_ENTRY';
export const FEATURE_FRAGMENT_ENTRY_ENV = 'DNAFORGE_FEATURE_FRAGMENT_ENTRY';

export interface DedicatedWorkerLikeV1 {
  on<A extends unknown[]>(
    event: 'message' | 'error' | 'exit',
    listener: (...args: A) => void
  ): unknown;
  removeListener<A extends unknown[]>(event: string, listener: (...args: A) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<unknown>;
}

export class ProcessWorkerV1 extends EventEmitter implements DedicatedWorkerLikeV1 {
  readonly #child: ChildProcess;
  readonly #exited: Promise<void>;

  constructor(modulePath: string, env: Readonly<Record<string, string>> = {}) {
    super();
    this.#child = fork(modulePath, [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.#exited = new Promise((resolve) => this.#child.once('exit', () => resolve()));
    this.#child.on('message', (message) => this.emit('message', message));
    this.#child.on('error', (error) => this.emit('error', error));
    this.#child.on('exit', (code, signal) => this.emit('exit', code ?? (signal ? 1 : 0)));
  }

  postMessage(message: unknown): void {
    this.#child.send(message as Parameters<ChildProcess['send']>[0]);
  }

  async terminate(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
    await this.#exited;
  }
}
