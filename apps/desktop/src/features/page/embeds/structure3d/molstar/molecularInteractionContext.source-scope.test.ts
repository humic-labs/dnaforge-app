import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure } from 'molstar/lib/mol-model/structure';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';
import { buildMolecularInteractionContext } from './molecularInteractionContext';
import {
  currentMolecularRenderProfile,
  resolveMolViewSpecRenderProfile,
} from './molecularRenderProfile';
import pdb from './fixtures/nucleotide-backbone-junction-1ibm.pdb?raw';

const walk = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(walk)];

describe('source-scoped interaction context construction', () => {
  it('normalizes the edited native source without rewriting other sources or story steps', async () => {
    const parsed = await parsePDB(pdb).run();
    if (parsed.isError) throw Error(parsed.message);
    const source = Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
    const target = { auth_asym_id: 'C', auth_seq_id: 34 };
    const loci = Structure.toStructureElementLoci(
      substructureFromSelector(source, componentPropsFromSelector(target))
    );
    const plugin = molstarPluginFixture({
      state: { data: { tree: { transforms: new Map() }, cells: new Map() } },
      managers: {
        asset: {},
        structure: {
          hierarchy: {
            current: { structures: [{ cell: { obj: { data: source } }, components: [] }] },
          },
        },
      },
      runTask: (task: { run: () => Promise<unknown> }) => task.run(),
    });
    const builder = MVSData.createBuilder();
    const structure = builder
      .download({ url: 'edited.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure();
    structure.component({ selector: 'nucleic' }).representation({ type: 'cartoon' });
    structure.component({ selector: target }).representation({ type: 'ball_and_stick' });
    const starter = resolveMolViewSpecRenderProfile(
      builder.getState(),
      currentMolecularRenderProfile(),
      () => true
    );
    if (starter.kind === 'multiple') throw Error('Expected one starter.');
    const root = starter.root as Node;
    walk(root).find((node) => node.kind === 'structure')!.ref = 'dnaforge:structure:edited';
    const archived = structuredClone(root);
    const sibling = structuredClone(root.children![0]);
    sibling.params!.url = 'untouched.pdb';
    walk(sibling).find((node) => node.kind === 'structure')!.ref = 'dnaforge:structure:untouched';
    walk(sibling)
      .find((node) => node.kind === 'component')!
      .children!.push({
        kind: 'focus',
        params: { direction: [0, 0, -1], up: [0, 1, 0], radius_extent: 4 },
      });
    root.children!.push(sibling);
    const document: MVSData = {
      kind: 'multiple',
      metadata: starter.metadata,
      snapshots: [
        {
          root: archived as never,
          metadata: { title: 'Archived source', linger_duration_ms: 1000 },
        },
        { root: root as never, metadata: { title: 'Edited source', linger_duration_ms: 1000 } },
      ],
    };
    const original = JSON.stringify(document);
    const result = await buildMolecularInteractionContext(
      plugin,
      document,
      loci,
      { sceneStructureRef: 'dnaforge:structure:edited', focus: false },
      1
    );
    const completed = MVSData.fromMVSJ(result.scene);
    if (completed.kind !== 'multiple') throw Error('The complete story was lost.');
    expect(JSON.stringify(document)).toBe(original);
    expect(JSON.stringify(completed.snapshots[0])).toBe(JSON.stringify(document.snapshots[0]));
    expect(JSON.stringify((completed.snapshots[1].root as Node).children![1])).toBe(
      JSON.stringify(sibling)
    );
    expect(result.context.environmentAtomCount).toBeGreaterThan(0);
    expect(
      walk(completed.snapshots[1].root as Node).some((node) => node.ref === result.contextRef)
    ).toBe(true);
    expect(MVSData.validationIssues(completed, { noExtra: true })).toBeUndefined();
  });
});
