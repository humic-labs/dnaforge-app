import type { MolstarLoadingExtension } from 'molstar/lib/extensions/mvs/load';
import type { CifFile } from 'molstar/lib/mol-io/reader/cif';
import type { StringLike } from 'molstar/lib/mol-io/common/string-like';
import type { Trajectory } from 'molstar/lib/mol-model/structure';
import {
  PluginStateObject as SO,
  PluginStateTransform,
} from 'molstar/lib/mol-plugin-state/objects';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { StateTransformer } from 'molstar/lib/mol-state';
import { Task } from 'molstar/lib/mol-task';
import type { MolstarPlugin } from './cache';

const MAX_SOURCES = 8;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 32;
type Identity = { key: string; byteLength: number };
type Decoded<T> = { data: T; label: string; description?: string };
type Source = Identity & {
  cif?: Decoded<CifFile>;
  trajectories: Map<string, Decoded<Trajectory>>;
};
const caches = new WeakMap<MolstarPlugin, Map<string, Source>>();
const cifIdentities = new WeakMap<CifFile, Identity>();

async function sourceIdentity(data: StringLike | Uint8Array, format: string): Promise<Identity> {
  const binary = data instanceof Uint8Array;
  const bytes = binary ? Uint8Array.from(data) : new TextEncoder().encode(data.toString());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return {
    key: `${format}:${binary ? 'binary' : 'text'}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    byteLength: bytes.byteLength,
  };
}

function source(plugin: MolstarPlugin, identity: Identity): Source {
  const cache = caches.get(plugin) ?? new Map<string, Source>();
  caches.set(plugin, cache);
  const retained = cache.get(identity.key) ?? { ...identity, trajectories: new Map() };
  cache.delete(identity.key);
  cache.set(identity.key, retained);
  return retained;
}

function trim(plugin: MolstarPlugin): void {
  const cache = caches.get(plugin)!;
  const totals = () =>
    Array.from(cache.values()).reduce(
      (sum, item) => ({
        bytes: sum.bytes + item.byteLength,
        frames:
          sum.frames +
          Array.from(item.trajectories.values()).reduce(
            (count, trajectory) => count + trajectory.data.frameCount,
            0
          ),
      }),
      { bytes: 0, frames: 0 }
    );
  let total = totals();
  while (cache.size > MAX_SOURCES || total.bytes > MAX_SOURCE_BYTES || total.frames > MAX_FRAMES) {
    cache.delete(cache.keys().next().value!);
    total = totals();
  }
}

export const CachedParseCif = PluginStateTransform.BuiltIn({
  name: 'dnaforge-cached-parse-cif',
  display: { name: 'Parse or reuse coordinate CIF' },
  from: [SO.Data.String, SO.Data.Binary],
  to: SO.Format.Cif,
})({
  apply(args, globalContext) {
    return Task.create('Parse or reuse coordinate CIF', async (ctx) => {
      const plugin = globalContext as MolstarPlugin;
      const identity = await sourceIdentity(args.a.data, 'cif');
      const retained = source(plugin, identity);
      if (retained.cif) return new SO.Format.Cif(retained.cif.data, retained.cif);
      const parsed = await Task.resolveInContext(
        StateTransforms.Data.ParseCif.definition.apply(args, globalContext),
        ctx
      );
      if (SO.Format.Cif.is(parsed)) {
        retained.cif = { data: parsed.data, label: parsed.label, description: parsed.description };
        cifIdentities.set(parsed.data, identity);
      }
      trim(plugin);
      return parsed;
    });
  },
});

export const CachedTrajectoryFromMmCif = PluginStateTransform.BuiltIn<
  typeof SO.Format.Cif,
  typeof SO.Molecule.Trajectory,
  StateTransformer.Params<typeof StateTransforms.Model.TrajectoryFromMmCif>
>({
  name: 'dnaforge-cached-trajectory-from-mmcif',
  display: { name: 'Decode or reuse coordinate model' },
  from: SO.Format.Cif,
  to: SO.Molecule.Trajectory,
  params: (a, context) =>
    StateTransformer.getParamDefinition(StateTransforms.Model.TrajectoryFromMmCif, a, context),
})({
  apply(args, globalContext) {
    return Task.create('Decode or reuse coordinate model', async (ctx) => {
      const plugin = globalContext as MolstarPlugin;
      const identity = cifIdentities.get(args.a.data);

      const blockIndex = args.params.blockHeader
        ? args.a.data.blocks.findIndex((block) => block.header === args.params.blockHeader)
        : (args.params.blockIndex ?? 0);
      const key = args.params.loadAllBlocks ? 'mmcif:all-blocks' : `mmcif:block:${blockIndex}`;
      const retained = identity ? source(plugin, identity) : undefined;
      const cached = retained?.trajectories.get(key);
      if (cached) return new SO.Molecule.Trajectory(cached.data, cached);
      const decoded = await Task.resolveInContext(
        StateTransforms.Model.TrajectoryFromMmCif.definition.apply(args, globalContext),
        ctx
      );
      if (retained && SO.Molecule.Trajectory.is(decoded)) {
        retained.trajectories.set(key, {
          data: decoded.data,
          label: decoded.label,
          description: decoded.description,
        });
        trim(plugin);
      }
      return decoded;
    });
  },
});

export const CachedTrajectoryFromPDB = PluginStateTransform.BuiltIn<
  typeof SO.Data.String,
  typeof SO.Molecule.Trajectory,
  StateTransformer.Params<typeof StateTransforms.Model.TrajectoryFromPDB>
>({
  name: 'dnaforge-cached-trajectory-from-pdb',
  display: { name: 'Decode or reuse coordinate PDB' },
  from: SO.Data.String,
  to: SO.Molecule.Trajectory,
  params: (a, context) =>
    StateTransformer.getParamDefinition(StateTransforms.Model.TrajectoryFromPDB, a, context),
})({
  apply(args, globalContext) {
    return Task.create('Decode or reuse coordinate PDB', async (ctx) => {
      const plugin = globalContext as MolstarPlugin;
      const identity = await sourceIdentity(args.a.data, `pdb:${args.params.variant}`);
      const retained = source(plugin, identity);
      const cached = retained.trajectories.get('pdb');
      if (cached) return new SO.Molecule.Trajectory(cached.data, cached);
      const decoded = await Task.resolveInContext(
        StateTransforms.Model.TrajectoryFromPDB.definition.apply(args, globalContext),
        ctx
      );
      if (SO.Molecule.Trajectory.is(decoded)) {
        retained.trajectories.set('pdb', {
          data: decoded.data,
          label: decoded.label,
          description: decoded.description,
        });
      }
      trim(plugin);
      return decoded;
    });
  },
});

const ReusableStructureComponent = PluginStateTransform.BuiltIn<
  typeof SO.Molecule.Structure,
  typeof SO.Molecule.Structure,
  StateTransformer.Params<typeof StateTransforms.Model.StructureComponent>
>({
  name: 'dnaforge-reusable-structure-component',
  display: { name: 'Update molecular component' },
  from: SO.Molecule.Structure,
  to: SO.Molecule.Structure,
  params: (a, context) =>
    StateTransformer.getParamDefinition(StateTransforms.Model.StructureComponent, a, context),
})({
  apply: (args, context) =>
    StateTransforms.Model.StructureComponent.definition.apply(args, context),
  update: (args, context) => {
    if (!args.a.data.model || !args.b.data.model) return StateTransformer.UpdateResult.Recreate;
    return StateTransforms.Model.StructureComponent.definition.update!(args, context);
  },
});

export const decodedCoordinateExtension: MolstarLoadingExtension<Record<string, never>> = {
  id: 'dnaforge/decoded-coordinates',
  description: 'Reuse decoded coordinates when switching molecular views.',
  createExtensionContext: () => ({}),
  action: (target) => {
    const transform = target.update.currentTree.transforms.get(target.selector.ref);
    if (!transform) return;
    const replacement =
      transform.transformer === StateTransforms.Data.ParseCif
        ? CachedParseCif
        : transform.transformer === StateTransforms.Model.TrajectoryFromMmCif
          ? CachedTrajectoryFromMmCif
          : transform.transformer === StateTransforms.Model.TrajectoryFromPDB
            ? CachedTrajectoryFromPDB
            : transform.transformer === StateTransforms.Model.StructureComponent
              ? ReusableStructureComponent
              : undefined;
    if (!replacement) return;
    target.update.delete(transform.ref);
    target.update.to(transform.parent).apply(replacement, transform.params, {
      ref: transform.ref,
      state: transform.state,
      tags: transform.tags ? [...transform.tags] : undefined,
      dependsOn: transform.dependsOn ? [...transform.dependsOn] : undefined,
    });
  },
};
