import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useCanvasStore } from '../canvas/public/store';
import {
  openStructureInspection,
  inspectionProteinKey,
  structureInspectionId,
} from './structure-inspection';
import { alleleStructureRequest, selectInspectionProteinProduct } from './inspection-allele';
import {
  coordinateDigest,
  molecularViewSchema,
  validateMolecularViewCoordinates,
  molecularViewAttrs,
  type MolecularView,
} from '../page/public/embeds/structure3d/molecularView';
import {
  attachSavedInspectionStructure,
  compareInspectionProteins,
  loadInspectionComparison,
} from './inspection-comparison';
const load = vi.hoisted(() => vi.fn());
vi.mock('./inspection-scene', () => ({ loadInspectionScene: load }));
const sequence =
  'MNIFEMLRIDEGLRLKIYKDTEGYYTIGIGHLLTKSPSLNAAKSELDKAIGRNTNGVITKDEAEKLFNQDVDAAVRGILRNAKLKPVYDSLDAVRRAALINMVFQMGETGVAGFTNSLRMLQQKRWDEAAVNLAKSRWYNQTPNRAKRVITTFRTGTWDAYKNL';
const alternate = sequence.slice(0, 98) + 'A' + sequence.slice(99);
const reference = () => ({
  entityId: 'dna',
  translation: sequence,
  moleculeType: 'protein' as const,
  residueMolecule: { moleculeId: 'reference', moleculeKind: 'protein' as const },
  variantContext: {
    position: 295,
    referenceBase: 'CT',
    alternateBase: 'GC',
    trackId: 'sample',
    trackLabel: 'Sample',
    mutationId: 'm',
    residueIndices: [98],
    product: {
      referenceLength: sequence.length,
      stop: { residue: 165, genomicPositions: [492, 493, 494] },
      extendedBeyondCds: false,
      status: 'complete' as const,
      basis: 'single-allele' as const,
      sequence: alternate,
      alternateToReference: Array.from(sequence, (_, i) => i),
    },
  },
});
function current() {
  const c = useCanvasStore.getState();
  const w = c.findTab('structure', structureInspectionId('dna'))!;
  return c.panels[w.panelId].tabs.find((t) => t.id === w.tabId)!.structureInspection!;
}
beforeEach(async () => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'dna',
    label: 'Reference',
    sequenceDocument: { kind: 'catalog-sequence', entityId: 'dna' },
  });
  const views = new Map<string, MolecularView>();
  for (const id of ['1L63', '1L90']) {
    const text = readFileSync(
      resolve(process.cwd(), '../../test-fixtures/structure-comparisons', `${id}.cif`),
      'utf8'
    );
    views.set(id, {
      kind: 'molecular-view',
      version: 1,
      title: id,
      caption: 'Public deposited coordinates',
      scene: '{}',
      coordinates: { text, format: 'cif', sha256: await coordinateDigest(text) },
      source: { source: 'pdb', sourceId: id },
      evidence: [],
      preview: 'data:image/png;base64,AA==',
      createdAt: 1,
    });
  }
  load.mockReset();
  load.mockImplementation(async (id) => views.get(id));
});
it('opens a distinct working comparison from two saved products and restores each original view', async () => {
  const ref = reference();
  openStructureInspection(ref, [], { candidateId: 'ref', savedViewReferenceId: '1L63' });
  selectInspectionProteinProduct('dna', 'allele');
  await attachSavedInspectionStructure('dna', '1L90');
  const comparison = await compareInspectionProteins('dna');
  expect(current().savedViewReferenceId).toBeUndefined();
  expect(current().comparison).toEqual(comparison);
  expect(inspectionProteinKey(current().request)).not.toBe(inspectionProteinKey(ref));
  expect(inspectionProteinKey(current().request)).not.toBe(
    inspectionProteinKey(alleleStructureRequest(ref))
  );
  const view = await loadInspectionComparison(current());
  expect(view.source.comparison?.reference.coordinates.text).toContain('data_1L63');
  expect(view.source.comparison?.alternate.coordinates.text).toContain('data_1L90');
  expect(view.source.comparison?.alignment.pairs).toHaveLength(161);
  expect(view.source.allele).toBeUndefined();
  selectInspectionProteinProduct('dna', 'reference');
  expect(current().savedViewReferenceId).toBe('1L63');
  selectInspectionProteinProduct('dna', 'allele');
  expect(current().savedViewReferenceId).toBe('1L90');
});
it('refuses a reference model attached as the changed allele', async () => {
  const ref = reference();
  openStructureInspection(ref);
  selectInspectionProteinProduct('dna', 'allele');
  await expect(attachSavedInspectionStructure('dna', '1L63')).rejects.toThrow(/sequence/i);
  expect(current().savedViewReferenceId).toBeUndefined();
});
it('requires two saved coordinate models before opening comparison', async () => {
  openStructureInspection(reference(), [], { savedViewReferenceId: '1L63' });
  await expect(compareInspectionProteins('dna')).rejects.toThrow(/save.*both/i);
  expect(current().request.comparisonOf).toBeUndefined();
});
it('does not attach a delayed model after the user changes product', async () => {
  openStructureInspection(reference());
  selectInspectionProteinProduct('dna', 'allele');
  const original = load.getMockImplementation()!;
  let release!: () => void;
  load.mockImplementation(async (id) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return original(id);
  });
  const pending = attachSavedInspectionStructure('dna', '1L90');
  selectInspectionProteinProduct('dna', 'reference');
  release();
  await expect(pending).rejects.toThrow(/changed/i);
  expect(current().savedViewReferenceId).toBeUndefined();
});

it('pins both original sources in a portable view and refuses altered source bytes or residue mappings', async () => {
  const ref = reference();
  openStructureInspection(ref, [], { savedViewReferenceId: '1L63' });
  selectInspectionProteinProduct('dna', 'allele');
  await attachSavedInspectionStructure('dna', '1L90');
  await compareInspectionProteins('dna');
  const working = await loadInspectionComparison(current());
  const saved = molecularViewSchema.parse({
    ...working,
    kind: 'molecular-view',
    version: 1,
    title: 'Comparison',
    caption: 'Test envelope',
    evidence: [],
    preview: 'data:image/png;base64,AA==',
    createdAt: 1,
  });
  await expect(validateMolecularViewCoordinates(saved)).resolves.toBeUndefined();
  expect(molecularViewAttrs('comparison', saved).comparisonProvenance).toEqual(
    saved.source.comparison
  );
  const altered = structuredClone(saved);
  altered.source.comparison!.alternate.coordinates.text += 'changed';
  await expect(validateMolecularViewCoordinates(altered)).rejects.toThrow(/source.*bytes/i);
  const remapped = structuredClone(saved);
  remapped.source.comparison!.allele.alternateToReference[10] = 0;
  await expect(validateMolecularViewCoordinates(remapped)).rejects.toThrow(/correspondence/i);
});

it('keeps the comparison when the same mutation is clicked again', async () => {
  const ref = reference();
  openStructureInspection(ref, [], { savedViewReferenceId: '1L63' });
  selectInspectionProteinProduct('dna', 'allele');
  await attachSavedInspectionStructure('dna', '1L90');
  await compareInspectionProteins('dna');
  const key = inspectionProteinKey(current().request);
  openStructureInspection({ ...ref }, []);
  expect(inspectionProteinKey(current().request)).toBe(key);
  expect(current().comparison?.alternateId).toBe('1L90');
  selectInspectionProteinProduct('dna', 'reference');
  expect(current().request.comparisonOf).toBeUndefined();
});
