import { MOLECULAR_COORDINATE_MAX_ENCODED_LENGTH } from '../../../../../shared/molecular-storage';
import { describe, expect, it } from 'vitest';
import { prepareMolecularDataPublication, molecularDataDigest } from './molecularData';
import {
  molecularViewSchema,
  molecularViewAttrs,
  validateMolecularViewCoordinates,
  molecularViewTargetSnapshotIndex,
  molecularViewReferenceTargets,
  molecularViewSourceForCoordinates,
} from './molecularView';

const coordinateText = 'HEADER SAVED VIEW\nEND\n';
const digest = 'd475d1656749714ddef3f00c0f07674d39db634924dd7a3e022f19b2b82ae04c';
const saved = {
  kind: 'molecular-view',
  version: 1,
  title: 'Original pocket',
  caption: 'Geometric contacts.',
  scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
  coordinates: { format: 'pdb', text: coordinateText, sha256: digest },
  source: { source: 'pdb', sourceId: '1IEP' },
  evidence: [{ title: 'RCSB 1IEP', url: 'https://www.rcsb.org/structure/1IEP' }],
  preview: 'data:image/png;base64,AAAA',
  createdAt: 1,
};

describe('durable molecular view envelope', () => {
  it('rejects semantically invalid mappings and absent signal columns even when their hashes are correct', async () => {
    const { dataset, mapping } = await prepareMolecularDataPublication({
      id: 'test',
      name: 'Test',
      records: [{ chain: 'A', value: 1 }],
      source: { label: 'Controlled data' },
      mapping: { coordinateSha256: digest, selectorColumns: { label_asym_id: 'chain' } },
    });
    const { revision, ...contents } = mapping;
    const invalidContents = {
      ...contents,
      targets: [{ row: 1, selector: { label_asym_id: 'A' } }],
    };
    const invalidMapping = {
      ...invalidContents,
      revision: await molecularDataDigest(invalidContents),
    };
    const bad = molecularViewSchema.parse({
      ...saved,
      molecularData: { version: 1, datasets: [dataset], mappings: [invalidMapping], layers: [] },
    });
    await expect(validateMolecularViewCoordinates(bad)).rejects.toThrow(/row/i);
    const wrongColumn = molecularViewSchema.parse({
      ...saved,
      molecularData: {
        version: 1,
        datasets: [dataset],
        mappings: [mapping],
        layers: [
          {
            id: 'missing',
            name: 'Missing signal',
            datasetId: dataset.id,
            dataRevision: dataset.revision,
            mappingRevision: mapping.revision,
            column: 'absent',
            style: { kind: 'categorical', colors: {}, missingColor: '#aaaaaa' },
          },
        ],
      },
    });
    await expect(validateMolecularViewCoordinates(wrongColumn)).rejects.toThrow(/column/i);
  });
  it('pins original general data and mappings; rejects changed rows or different coordinates', async () => {
    const { dataset, mapping } = await prepareMolecularDataPublication({
      id: 'python-result',
      name: 'Supplied ratio',
      records: [{ chain: 'A', ratio: 0, note: 'RNA' }],
      source: { label: 'Controlled test input' },
      mapping: { coordinateSha256: digest, selectorColumns: { label_asym_id: 'chain' } },
    });
    const view = molecularViewSchema.parse({
      ...saved,
      molecularData: { version: 1, datasets: [dataset], mappings: [mapping], layers: [] },
    });
    expect(molecularViewAttrs('saved-data', view).molecularData).toEqual(view.molecularData);
    await expect(validateMolecularViewCoordinates(view)).resolves.toBeUndefined();
    const altered = structuredClone(view);
    altered.molecularData!.datasets[0].records[0].ratio = 10;
    await expect(validateMolecularViewCoordinates(altered)).rejects.toThrow(/data.*revision/i);
    const moved = structuredClone(view);
    moved.molecularData!.mappings[0].coordinateSha256 = 'f'.repeat(64);
    await expect(validateMolecularViewCoordinates(moved)).rejects.toThrow(/mapping/i);
  });
  it('keeps prediction identity in a portable saved scene and rejects provenance for different coordinates', async () => {
    const prediction = {
      provider: 'tamarind',
      toolId: 'esmfold',
      remoteId: 'job-42',
      jobRecordId: 'local-job-1',
      proteinSequenceSha256: 'a'.repeat(64),
      coordinateSha256: digest,
      metrics: { plddt: 90 },
    };
    const view = molecularViewSchema.parse({ ...saved, source: { source: 'file', prediction } });
    expect(molecularViewAttrs('saved-prediction', view).predictionProvenance).toEqual(prediction);
    await expect(validateMolecularViewCoordinates(view)).resolves.toBeUndefined();
    await expect(
      validateMolecularViewCoordinates({
        ...view,
        source: { ...view.source, prediction: { ...prediction, coordinateSha256: 'b'.repeat(64) } },
      })
    ).rejects.toThrow(/prediction/);
  });

  it('keeps single-allele DNA provenance and residue correspondence in a portable scene', () => {
    const allele = {
      basis: 'single-allele',
      documentId: 'reference',
      position: 4,
      referenceBase: 'A',
      alternateBase: 'T',
      referenceProteinSha256: 'a'.repeat(64),
      proteinSequenceSha256: 'b'.repeat(64),
      referenceLength: 3,
      alternateToReference: [0],
      proteinLength: 1,
    };
    const view = molecularViewSchema.parse({ ...saved, source: { source: 'file', allele } });
    expect(molecularViewAttrs('saved-allele', view).alleleProvenance).toEqual(allele);
  });

  it('opens its own coordinates and authored scene rather than the latest registered structure', () => {
    const data = molecularViewSchema.parse(saved);
    expect(molecularViewAttrs('saved-view:original', data)).toMatchObject({
      source: 'file',
      sourceId: coordinateText,
      coordinateSha256: digest,
      molViewSpec: saved.scene,
      label: saved.title,
    });
  });

  it('keeps the provider identity separate from the native coordinate transport', () => {
    const source = { ...saved.source, providerIdentityKey: 'RCSB:1IEP:ENTRY' };
    const attrs = molecularViewAttrs(
      'saved-provider',
      molecularViewSchema.parse({ ...saved, source })
    );
    expect(attrs.source).toBe('file');
    expect(attrs.sourceId).toBe(coordinateText);
    expect(attrs.coordinateSource).toEqual({ sha256: digest, source });
    expect(
      molecularViewSourceForCoordinates(attrs, { sha256: digest }, { source: 'file' })
    ).toEqual(source);
    expect(
      molecularViewSourceForCoordinates(attrs, { sha256: 'f'.repeat(64) }, { source: 'file' })
    ).toEqual({ source: 'file' });
    expect(
      molecularViewSourceForCoordinates(
        attrs,
        { sha256: digest },
        { source: 'pdb', sourceId: '1CRN' }
      )
    ).toEqual({ source: 'pdb', sourceId: '1CRN' });
  });

  it('preserves the active story step while keeping version-one saved views readable', () => {
    expect(molecularViewSchema.parse(saved).initialSnapshotIndex).toBeUndefined();
    const story = molecularViewSchema.parse({ ...saved, initialSnapshotIndex: 1 });
    expect(molecularViewAttrs('saved-view:story', story).molViewSpecSnapshotIndex).toBe(1);
  });

  it('admits larger stored snapshots while bounding the serialized coordinate field', () => {
    expect(molecularViewSchema.safeParse({ ...saved, version: 2 }).success).toBe(false);
    expect(
      molecularViewSchema.safeParse({
        ...saved,
        coordinates: { ...saved.coordinates, text: 'x'.repeat(8_000_001) },
      }).success
    ).toBe(true);
    expect(
      molecularViewSchema.safeParse({
        ...saved,
        coordinates: {
          ...saved.coordinates,
          text: 'x'.repeat(MOLECULAR_COORDINATE_MAX_ENCODED_LENGTH + 1),
        },
      }).success
    ).toBe(false);
  });

  it('rejects tampered pinned coordinate bytes before opening a viewer', async () => {
    await expect(
      validateMolecularViewCoordinates(
        molecularViewSchema.parse({
          ...saved,
          coordinates: { ...saved.coordinates, text: coordinateText + 'changed' },
        })
      )
    ).rejects.toThrow('digest');
  });

  it('accepts the exact pinned coordinate bytes', async () => {
    await expect(
      validateMolecularViewCoordinates(molecularViewSchema.parse(saved))
    ).resolves.toBeUndefined();
  });

  it('resolves a stable view identity after reordering and preserves exact legacy index links', () => {
    const view = molecularViewSchema.parse({
      ...saved,
      scene: JSON.stringify({
        kind: 'multiple',
        snapshots: [
          { metadata: { key: 'detail', title: 'Detail' }, root: { kind: 'root' } },
          { metadata: { key: 'overview', title: 'Overview' }, root: { kind: 'root' } },
        ],
      }),
    });
    expect(molecularViewTargetSnapshotIndex(view, { viewId: 'overview' })).toBe(1);
    expect(molecularViewTargetSnapshotIndex(view, { snapshotIndex: 0 })).toBe(0);
    expect(() =>
      molecularViewTargetSnapshotIndex(view, { viewId: 'missing', snapshotIndex: 0 })
    ).toThrow(/view/i);
    expect(molecularViewReferenceTargets(crypto.randomUUID(), view)[1].selection).toMatchObject({
      viewId: 'overview',
      snapshotIndex: 1,
    });
  });
});
