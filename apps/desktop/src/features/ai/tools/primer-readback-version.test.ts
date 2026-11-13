// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPrimerArtifact } from '../../primers/public/primer-artifact';
import { getPrimerOutputSchema } from './design-output-schemas';

describe('agent primer readback format', () => {
  it('accepts the format written by the real primer artifact owner', async () => {
    const artifact = await buildPrimerArtifact({
      id: 'assembly-primer-readback', catalogNumber: 'P1', name: 'Assembly primer',
      sequence: 'GGGGACGTCCTAGTCAGATCGATCG',
      annealing: { overhangSequence: 'GGGG', pbsSequence: 'ACGTCCTAGTCAGATCGATCG' },
      workspaceRoot: '/assembly-project', artifactPath: '/assembly-project/primers/readback.primer.json', now: 1,
    });
    const reference = { path: artifact.file.workspaceRelativePath, checksum: 'sha256:content', schema: artifact.schema, schemaVersion: artifact.schemaVersion };
    expect(getPrimerOutputSchema.shape.artifact.safeParse(reference).success).toBe(true);
    expect(getPrimerOutputSchema.shape.artifact.safeParse({ ...reference, schemaVersion: 2 }).success).toBe(true);
    expect(getPrimerOutputSchema.shape.artifact.safeParse({ ...reference, schemaVersion: 4 }).success).toBe(false);
  });
});
