import { execFile } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DNA_INDEXER_ASSEMBLY_INGEST_TIMEOUT_MS = 5 * 60 * 1_000;

export async function runDnaIndexerAssemblyIngestProcess(input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = input.timeoutMs ?? DNA_INDEXER_ASSEMBLY_INGEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('dna-indexer assembly ingestion timeout must be a positive integer.');
  }
  try {
    const { stdout } = await execDnaIndexerFile(input.binary, input.args, timeoutMs, {
      DNA_INDEXER_FINALIZE_WORKERS:
        process.env.DNA_INDEXER_FINALIZE_WORKERS ?? String(assemblyFinalizeWorkerCount()),
    });
    return stdout;
  } catch (error) {
    if (isForceKilledChildProcess(error)) {
      throw new Error(
        `dna-indexer assembly ingestion exceeded the ${timeoutMs} ms process deadline and was force-terminated.`,
        { cause: error }
      );
    }
    throw error;
  }
}

export function execDnaIndexerFile(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Readonly<Record<string, string>>
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(binary, [...args], {
    ...(env ? { env: { ...process.env, ...env } } : {}),
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
}

function isForceKilledChildProcess(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'killed' in error &&
    (error as { killed?: unknown }).killed === true &&
    'signal' in error &&
    (error as { signal?: unknown }).signal === 'SIGKILL'
  );
}

export function assemblyFinalizeWorkerCount(
  cores = availableParallelism(),
  memoryBytes = totalmem()
): number {
  const byMemory = Math.floor(memoryBytes / (4 * 1024 ** 3));
  return Math.max(2, Math.min(Math.floor(cores / 2), byMemory));
}
