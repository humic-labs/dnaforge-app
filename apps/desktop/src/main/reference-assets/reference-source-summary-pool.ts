import { fork, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';

import summaryEntryPath from './reference-source-summary-process-entry?modulePath';
import type { ChromosomeSourceSummaryJobV1 } from './reference-source-summary';

export async function ensureChromosomeSourceSummariesInProcessesV1(
  jobs: readonly ChromosomeSourceSummaryJobV1[],
  onStart?: (job: ChromosomeSourceSummaryJobV1) => void,
  processCount = Math.max(1, Math.min(6, Math.floor(availableParallelism() / 3)))
): Promise<void> {
  const queue = [...jobs].sort((left, right) => right.length - left.length);
  const processes: ChildProcess[] = Array.from(
    { length: Math.min(processCount, jobs.length) },
    () =>
      fork(summaryEntryPath, [], {
        execPath: process.execPath,
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
  );
  let nextId = 0;
  try {
    await Promise.all(
      processes.map(async (child) => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          onStart?.(job);
          await runSummary(child, nextId++, job);
        }
      })
    );
  } finally {
    for (const child of processes) child.kill();
  }
}

function runSummary(
  child: ChildProcess,
  id: number,
  job: ChromosomeSourceSummaryJobV1
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (message: { id: number; error?: { name: string; message: string } }) => {
      if (message?.id !== id) return;
      cleanup();
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        reject(error);
      } else {
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Source summary process exited (${code ?? signal}).`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
    child.send({ id, job });
  });
}
