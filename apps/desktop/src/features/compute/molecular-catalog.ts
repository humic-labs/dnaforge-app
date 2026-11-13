import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import type {
  MolecularCatalogLoaded,
  MolecularCatalogRegisterInput,
} from '../../shared/molecular-catalog';
import { openDocument } from '../document-opening/public/open-document';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';

const loads = new Map<string, Promise<MolecularCatalogLoaded>>();
export const MOLECULAR_CATALOG_CHANGED = 'waypoint:molecular-catalog-changed';
export async function registerCatalogStructure(input: MolecularCatalogRegisterInput) {
  const registered = await platform().molecularCatalog.register(input);

  loads.delete(registered.observation.id);
  window.dispatchEvent(new Event(MOLECULAR_CATALOG_CHANGED));
  return registered;
}
export function loadCatalogStructure(id: string): Promise<MolecularCatalogLoaded> {
  let pending = loads.get(id);
  if (!pending) {
    pending = platform()
      .molecularCatalog.load(id)
      .catch((error) => {
        loads.delete(id);
        throw error;
      });
    if (loads.size >= 12) loads.delete(loads.keys().next().value!);
    loads.set(id, pending);
  }
  return pending;
}

export async function catalogStructureAttrs(
  observationId: string,
  chainKey?: string
): Promise<Structure3dAttrs> {
  const loaded = await loadCatalogStructure(observationId);
  const chain = chainKey
    ? loaded.inventory.chains.find((item) => item.key === chainKey)
    : undefined;
  if (chainKey && !chain)
    throw new Error('The selected source chain was not found in this saved structure.');
  return {
    source: 'file',
    sourceId: `catalog:${observationId}`,
    catalogSource: { observationId, ...(chainKey ? { chainKey } : {}) },
    coordinateSha256: loaded.observation.coordinateSha256,
    catalogProvenance: loaded.observation,
    ...(chain
      ? { coordinateModel: { blockIndex: chain.blockIndex, modelIndex: chain.modelIndex } }
      : {}),
    providerIdentityKey: `catalog:${loaded.observation.coordinateId}`,
    label: loaded.observation.label,
    representation: 'cartoon',
    colorMode: 'chain',
    ...(chain ? { labelAsymIds: [chain.labelAsymId], authAsymIds: [chain.authAsymId] } : {}),
  };
}

export async function openCatalogStructure(observationId: string, chainKey?: string) {
  const attrs = await catalogStructureAttrs(observationId, chainKey);
  const opened = await openDocument({
    target: {
      kind: 'record',
      tabType: 'structure',
      entityId: `catalog-view:${observationId}:${chainKey ?? 'complex'}`,
    },
    label: attrs.label,
    placement: { kind: 'smart' },
    view: { initialStructureAttrs: attrs },
  });
  if (opened.status !== 'presented') throw new Error('The saved structure could not be presented.');
  return opened;
}

export function useCatalogCoordinates(ref: Structure3dAttrs['catalogSource']) {
  const id = ref?.observationId;
  const [state, setState] = useState<{
    id: string;
    data?: string | Uint8Array;
    format?: 'pdb' | 'mmcif';
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    if (id)
      void loadCatalogStructure(id)
        .then((loaded) => {
          if (active)
            setState({
              id,
              data:
                loaded.observation.format === 'bcif'
                  ? loaded.bytes
                  : new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes),
              format: loaded.observation.format === 'pdb' ? 'pdb' : 'mmcif',
            });
        })
        .catch((error) => {
          if (active)
            setState({ id, error: error instanceof Error ? error.message : String(error) });
        });
    return () => {
      active = false;
    };
  }, [id]);
  return id && state?.id === id ? state : undefined;
}
