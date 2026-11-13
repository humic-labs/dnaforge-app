import { z } from 'zod';
import { platform } from '../../platform';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { getStructureFileFormat } from '../../shared/scientific-file-types';
import { canonicalPredictionProtein } from '../../shared/compute-protein-sequence';
import type { ComputeJobRecord } from '../../shared/compute-jobs-ipc';
import { readDesktopScientificDocument } from '../scientific-document/public/read-desktop-scientific-document';
import { listProteinPredictions, registerPredictionResult } from './prediction-library';

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.string(),
  tool: z.string(),
  remoteId: z.string(),
  settingsHash: z.string(),
  testMode: z.boolean(),
  metrics: z.record(z.unknown()),
  provenance: z.record(z.string()),
});
const recovering = new Map<string, Promise<string[]>>();

async function indexPriorImport(job: ComputeJobRecord, paths: string[]): Promise<string[]> {
  const existing = recovering.get(job.id);
  if (existing) return existing;
  const operation = (async () => {
    const notices: string[] = [];
    try {
      if (!job.workspaceRoot) throw new Error('The run has no recorded source workspace.');
      const read = async (filePath: string) => {
        if (!isPathInsideBoundary(filePath, job.workspaceRoot!))
          throw new Error('An imported file is outside this run’s workspace.');
        const result = await readDesktopScientificDocument({
          filePath,
          workspaceRoot: job.workspaceRoot!,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.document.content;
      };
      const receiptPath = job.importedPaths.find((path) =>
        /(?:^|[\\/])compute-job\.json$/.test(path)
      );
      if (!receiptPath) throw new Error('The original compute result receipt is missing.');
      const receipt = receiptSchema.parse(JSON.parse(await read(receiptPath)));
      if (
        receipt.provider !== job.provider ||
        receipt.remoteId !== job.remoteId ||
        receipt.tool !== job.toolId ||
        receipt.settingsHash !== job.settingsHash
      )
        throw new Error('The imported result receipt does not match this run.');
      if (receipt.testMode || receipt.provenance.livemode === 'false')
        throw new Error('Provider test-mode output is not a prediction of this protein.');
      for (const filePath of paths) {
        try {
          const format = getStructureFileFormat(filePath)!;
          await registerPredictionResult({
            job,
            filePath,
            coordinates: {
              text: await read(filePath),
              format: format.parser === 'pdb' ? 'pdb' : 'cif',
            },
            metrics: receipt.metrics,
            provenance: {
              ...receipt.provenance,
              recovered_from:
                'Previously imported coordinate file; first pinned when indexed for reuse. Original provider bytes were not previously pinned.',
            },
          });
        } catch (error) {
          notices.push(
            `${job.label ?? job.toolId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch (error) {
      notices.push(
        `${job.label ?? job.toolId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return notices;
  })();
  recovering.set(job.id, operation);
  try {
    return await operation;
  } finally {
    if (recovering.get(job.id) === operation) recovering.delete(job.id);
  }
}

export async function discoverProteinPredictions(sequence: string) {
  const canonical = canonicalPredictionProtein(sequence);
  const [runs, pinned] = await Promise.all([
    platform().compute.listJobs({ proteinSequence: canonical, limit: 1000 }),
    listProteinPredictions(canonical),
  ]);
  const indexed = new Set(
    pinned.map((row) => JSON.stringify([row.run.jobRecordId, row.origin.filePath]))
  );
  const notices: string[] = [];
  for (const job of runs) {
    if (job.state !== 'imported') continue;
    const missing = job.importedPaths.filter(
      (path) =>
        getStructureFileFormat(path)?.encoding === 'text' &&
        !indexed.has(JSON.stringify([job.id, path]))
    );
    if (missing.length) notices.push(...(await indexPriorImport(job, missing)));
  }
  if (runs.length === 1000)
    notices.push('Showing the latest 1,000 matching runs. All pinned matching results are listed.');
  return {
    predictions: await listProteinPredictions(canonical),
    notices,
    runs: runs.map(
      ({
        id,
        provider,
        toolId,
        remoteId,
        label,
        state,
        createdAt,
        workspaceRoot,
        settingsHash,
        lastError,
      }) => ({
        id,
        provider,
        toolId,
        remoteId,
        label,
        state,
        createdAt,
        workspaceRoot,
        settingsHash,
        lastError,
      })
    ),
  };
}
