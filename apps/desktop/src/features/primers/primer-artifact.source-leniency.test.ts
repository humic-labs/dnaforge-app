import { describe, it, expect } from 'vitest';
import { calculateGcContent, calculateTmNN } from '../design/algorithms/tm-calculator';
import { PRIMER_ARTIFACT_SCHEMA_VERSION, parsePrimerArtifact, sha256Hex } from './primer-artifact';

async function primerArtifactJsonWithMetadataSource(source: unknown): Promise<string> {
  const bases = 'ATCGATCGATCGATCGATCG';
  const timestamp = new Date(1_750_000_000_000).toISOString();
  const artifact = {
    schema: 'dnaforge.primer',
    schemaVersion: 1,
    artifactRevision: 1,
    id: 'primer-leniency-1',
    name: 'Leniency probe',
    catalogNumber: 'P001',
    sequence: {
      bases,
      topology: 'linear',
      length: bases.length,
      contentHash: await sha256Hex(bases),
    },
    computed: {
      tmC: calculateTmNN(bases),
      gcPercent: calculateGcContent(bases),
    },
    metadata: {
      createdAt: timestamp,
      updatedAt: timestamp,
      actor: 'test',
      source,
      application: null,
      notes: null,
    },
    registry: { required: true, entityId: 'primer-leniency-1', kind: 'oligo', use: 'primer' },
    file: { workspaceRelativePath: 'primers/leniency.primer.json' },
    bindings: [],
  };
  return JSON.stringify(artifact);
}

async function primerArtifactJsonWithSchemaVersion(schemaVersion: number): Promise<string> {
  const base = JSON.parse(await primerArtifactJsonWithMetadataSource('manual'));
  base.schemaVersion = schemaVersion;
  return JSON.stringify(base);
}

describe('parsePrimerArtifact metadata.source leniency (A1)', () => {
  it("accepts source: 'assembly' and preserves it", async () => {
    const parsed = parsePrimerArtifact(await primerArtifactJsonWithMetadataSource('assembly'));
    expect(parsed.metadata.source).toBe('assembly');
  });

  it("keeps the known members ('drag-selection', 'manual', 'reconciled') verbatim", async () => {
    for (const known of ['drag-selection', 'manual', 'reconciled'] as const) {
      const parsed = parsePrimerArtifact(await primerArtifactJsonWithMetadataSource(known));
      expect(parsed.metadata.source).toBe(known);
    }
  });

  it("coerces an unrecognized string source to 'manual' without throwing", async () => {
    const parsed = parsePrimerArtifact(
      await primerArtifactJsonWithMetadataSource('totally-unknown-future-source')
    );
    expect(parsed.metadata.source).toBe('manual');
  });

  it('still throws when source is not a string at all', async () => {
    const json = await primerArtifactJsonWithMetadataSource(42);
    expect(() => parsePrimerArtifact(json)).toThrow('Primer artifact metadata is invalid.');
  });

  it('still rejects a bumped schemaVersion (no self-brick migration)', async () => {
    const json = await primerArtifactJsonWithSchemaVersion(PRIMER_ARTIFACT_SCHEMA_VERSION + 1);
    expect(() => parsePrimerArtifact(json)).toThrow('Unsupported primer artifact schema version');
  });
});
