import { Loci } from 'molstar/lib/mol-model/loci';
import { StructureSelection, StructureElement, Structure } from 'molstar/lib/mol-model/structure';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { Script } from 'molstar/lib/mol-script/script';
import { transpiler as pymolTranspiler } from 'molstar/lib/mol-script/transpilers/pymol/parser';
import {
  molecularExactSelectionSchema,
  type MolecularExactSelection,
} from './molecularExactSelectionSchema';
import type { MolstarPlugin } from '../../page/public/embeds/structure3d/viewerCache';
import { molecularAtomSelector } from '../../page/public/embeds/structure3d/molstar/molecularConnections';
import {
  molViewSpecStructureBindings,
  resolveMolViewSpecStructureRef,
} from '../../page/public/embeds/structure3d/molstar/molViewSpecStructureIdentity';
import { buildMolecularInteractionContext } from '../../page/public/embeds/structure3d/molstar/molecularInteractionContext';
import {
  getMolViewSpecScene,
  sameMolViewSpecDisplayTree,
  MolViewSpecSceneError,
} from '../../page/public/embeds/structure3d/molstar/molViewSpec';
import type { molShowInteractionContextSchema } from './contracts';
import { throwStructureError } from './errors';

type InteractionContextInput = ReturnType<typeof molShowInteractionContextSchema.parse>;

function parsePymolSelection(selection: string) {
  try {
    return pymolTranspiler(selection);
  } catch (error) {
    throwStructureError(
      'SELECTION_PARSE_ERROR',
      error instanceof Error ? error.message : 'Selection could not be parsed.',
      { selection }
    );
  }
}

export function lociForSelection(plugin: MolstarPlugin, selection: string): Loci[];
export function lociForSelection(
  plugin: MolstarPlugin,
  selection: string | MolecularExactSelection,
  source: Structure
): Loci;
export function lociForSelection(
  plugin: MolstarPlugin,
  selection: string | MolecularExactSelection,
  source?: Structure
): Loci | Loci[] {
  if (typeof selection !== 'string') {
    if (!source)
      throwStructureError(
        'MVS_STRUCTURE_IDENTITY_REQUIRED',
        'Exact MVS selections require their declared coordinate source.',
        { selection }
      );
    try {
      const exact = molecularExactSelectionSchema.parse(selection);
      return Structure.toStructureElementLoci(
        substructureFromSelector(source, componentPropsFromSelector(exact))
      );
    } catch (error) {
      throwStructureError(
        'SELECTION_PARSE_ERROR',
        error instanceof Error ? error.message : 'Exact molecular selection could not be applied.',
        { selection }
      );
    }
  }
  const expression = parsePymolSelection(selection);
  if (source)
    return StructureSelection.toLociWithSourceUnits(
      Script.getStructureSelection(expression, source)
    );
  const structures = plugin.managers.structure.hierarchy.current.structures;
  if (!structures.length)
    throwStructureError(
      'PLUGIN_NOT_READY',
      'Mol* structure data is not ready.',
      { selection },
      true
    );
  return structures.flatMap((structure) => {
    const data = structure.cell?.obj?.data;
    if (!data) return [];
    const loci = StructureSelection.toLociWithSourceUnits(
      Script.getStructureSelection(expression, data)
    );
    return Loci.isEmpty(loci) ? [] : [loci];
  });
}

export async function prepareMolecularInteractionContext(
  plugin: MolstarPlugin,
  input: InteractionContextInput
) {
  const current = getMolViewSpecScene(plugin);

  const document = MVSData.fromMVSJ(current.scene);
  const identities = molViewSpecStructureBindings(document, current.story?.activeIndex ?? 0);
  const sceneStructureRef =
    input.sceneStructureRef ?? (identities.length === 1 ? identities[0].ref : undefined);
  if (!sceneStructureRef || !identities.some((identity) => identity.ref === sceneStructureRef))
    throw new MolViewSpecSceneError(
      'AMBIGUOUS_STRUCTURE',
      'Specify sceneStructureRef from mol_get_scene.structureIdentities for this interaction source.'
    );
  const source = resolveMolViewSpecStructureRef(plugin, sceneStructureRef);
  const loci = lociForSelection(plugin, input.selection, source);
  if (!StructureElement.Loci.is(loci) || Loci.isEmpty(loci))
    throw new MolViewSpecSceneError('EMPTY_SELECTION', 'The interaction target matched no atoms.');
  const targetSideLoci = input.targetSelection
    ? lociForSelection(plugin, input.targetSelection, source)
    : undefined;
  if (targetSideLoci && (!StructureElement.Loci.is(targetSideLoci) || Loci.isEmpty(targetSideLoci)))
    throw new MolViewSpecSceneError(
      'EMPTY_SELECTION',
      'The scientific target side matched no atoms.'
    );
  const partnerLoci = input.partnerSelection
    ? lociForSelection(plugin, input.partnerSelection, source)
    : undefined;
  if (partnerLoci && (!StructureElement.Loci.is(partnerLoci) || Loci.isEmpty(partnerLoci)))
    throw new MolViewSpecSceneError('EMPTY_SELECTION', 'The binding partner matched no atoms.');
  const plan = await buildMolecularInteractionContext(
    plugin,
    document,
    loci,
    {
      ...input,
      sceneStructureRef,
      ...(targetSideLoci && StructureElement.Loci.is(targetSideLoci)
        ? {
            targetSelector: molecularAtomSelector(
              StructureElement.Loci.toStructure(targetSideLoci),
              targetSideLoci.structure
            ),
          }
        : {}),
      ...(partnerLoci && StructureElement.Loci.is(partnerLoci)
        ? {
            partnerSelector: molecularAtomSelector(
              StructureElement.Loci.toStructure(partnerLoci),
              partnerLoci.structure
            ),
          }
        : {}),
    },
    current.story?.activeIndex ?? 0
  );
  if (
    !sameMolViewSpecDisplayTree(
      getMolViewSpecScene(plugin).scene,
      current.scene,
      current.resources.map((resource) => resource.uri)
    )
  )
    throw new MolViewSpecSceneError(
      'VIEW_CHANGED',
      'The authored scene changed during contact calculation.'
    );
  return {
    ...plan,
    expectedScene: current.scene,
    snapshotIndex: current.story?.activeIndex ?? 0,
  };
}
