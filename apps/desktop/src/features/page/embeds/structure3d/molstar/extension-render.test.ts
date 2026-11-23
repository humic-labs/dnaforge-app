import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure, StructureElement, StructureSymmetry } from 'molstar/lib/mol-model/structure';
import type { Representation } from 'molstar/lib/mol-repr/representation';
import { MarkerAction } from 'molstar/lib/mol-util/marker-action';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { activateExtensionRender } from './extension-render';

function triangle() {
  return {
    positions: Float32Array.of(21, 35, 28, 22, 36, 28, 21, 36, 27),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    tangents: Float32Array.of(1, 0, 0, 1, 0, 0, 1, 0, 0),
    indices: Uint32Array.of(0, 1, 2),
    info: new Float32Array(12),
    surf: new Float32Array(12),
    phys: new Float32Array(12),
    helpersGLSL: '',
    shaderGLSL: '',
    residues: [{ chainId: 'A', resSeq: 152, iCode: '', name: 'ASP' }],
  };
}

describe('extension ribbons in a Mol* scene', () => {
  it('maps picks and selection markers to the correct copy of a residue in a biological assembly', async () => {
    const text = readFileSync(
      resolve(process.cwd(), '../../test-fixtures/structure-complexes/rcsb/1A8O.cif'),
      'utf8'
    );
    const parsed = await CIF.parseText(text).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const structure = await StructureSymmetry.buildAssembly(
      Structure.ofModel(trajectory.representative),
      '1'
    ).run();
    const shapes: Representation.Any[] = [];
    const remove = vi.fn();
    const plugin = molstarPluginFixture({
      canvas3d: {
        add: (repr) => {
          shapes.push(repr);
        },
        remove,
        commit: vi.fn(),
        syncVisibility: vi.fn(),
        requestDraw: vi.fn(),
      },
      managers: {
        structure: {
          hierarchy: {
            current: { structures: [{ cell: { obj: { data: structure } }, components: [] }] },
          },
        },
      },
    });
    const controller = new AbortController();
    const dispose = await activateExtensionRender(plugin, triangle(), controller.signal);
    expect(shapes).toHaveLength(2);
    const picks = shapes.map((shape) =>
      shape.getLoci({ objectId: shape.renderObjects[0].id, instanceId: 0, groupId: 0 })
    );
    const operators = picks.map((loci) => {
      if (!StructureElement.Loci.is(loci)) throw Error('Missing residue pick');
      expect(StructureElement.Loci.size(loci)).toBe(8);
      return loci.elements[0].unit.conformation.operator.instanceId;
    });
    expect(new Set(operators)).toEqual(new Set(['ASM-1', 'ASM-2']));
    expect(shapes[0].mark(picks[1], MarkerAction.Select)).toBe(false);
    expect(shapes[1].mark(picks[1], MarkerAction.Select)).toBe(true);
    controller.abort();
    dispose();
    expect(remove.mock.calls.map(([repr]) => repr)).toEqual(shapes);
  });

  it('rejects bad geometry before adding a representation', async () => {
    const plugin = molstarPluginFixture({});
    const ribbon = triangle();
    ribbon.indices[2] = ribbon.positions.length / 3;
    await expect(
      activateExtensionRender(plugin, ribbon, new AbortController().signal)
    ).rejects.toThrow(/missing vertex/);
  });
});
