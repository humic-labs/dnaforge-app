import type { MolstarLoadingExtension } from 'molstar/lib/extensions/mvs/load';
import { UpdateTarget } from 'molstar/lib/extensions/mvs/load-generic';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { formatMolScript } from 'molstar/lib/mol-script/language/expression-formatter';

export const MolecularInterfaceSurfaceExtension: MolstarLoadingExtension<undefined> = {
  id: 'dnaforge/interface-surface-burial',
  description: 'Show a native residue surface patch induced by the declared partner.',
  createExtensionContext: () => undefined,
  action: (target, node) => {
    if (node.kind !== 'representation') return;
    const patch = node.custom?.dnaforge_interface_surface_patch as
      | { contract?: string; selector?: unknown }
      | undefined;
    if (!patch) return;
    if (
      patch.contract !== 'native-molstar-interface-burial-v1' ||
      !Array.isArray(patch.selector) ||
      !patch.selector.length
    )
      throw Error('An interface surface requires its computed nonempty native burial patch.');
    const selection = componentPropsFromSelector(patch.selector);
    if (selection.name !== 'expression')
      throw Error('An interface surface requires exact computed atoms.');
    const outside = MS.struct.modifier.exceptBy({
      0: MS.struct.generator.all(),
      by: selection.params,
    });
    UpdateTarget.apply(
      target,
      StateTransforms.Representation.TransparencyStructureRepresentation3DFromScript,
      {
        layers: [
          { script: { language: 'mol-script', expression: formatMolScript(outside) }, value: 1 },
        ],
      }
    );
  },
};
