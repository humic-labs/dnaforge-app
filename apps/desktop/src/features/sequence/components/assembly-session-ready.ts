import type { GenomeSessionShell } from '../../../shared/indexed-genome';

export const ASSEMBLY_SESSION_READY_TIMEOUT_MS = 15_000;
export const ASSEMBLY_SESSION_READY_POLL_MS = 50;

export async function waitForCoordinateReadyGenomeSession(input: {
  initialShell: GenomeSessionShell;
  getSession: (sessionId: string) => Promise<GenomeSessionShell>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<GenomeSessionShell> {
  const timeoutMs = input.timeoutMs ?? ASSEMBLY_SESSION_READY_TIMEOUT_MS;
  const pollMs = input.pollMs ?? ASSEMBLY_SESSION_READY_POLL_MS;
  let latest = input.initialShell;

  if (isCoordinateReady(latest)) return latest;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollMs);
    latest = await input.getSession(input.initialShell.sessionId);
    if (isCoordinateReady(latest)) return latest;
  }

  throw new Error(
    `[assembly-session] ${input.initialShell.chrom} session did not become coordinate-ready`
  );
}

function isCoordinateReady(shell: GenomeSessionShell): boolean {
  return shell.coordinateReady && Boolean(shell.manifest);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
