import type { Structure3dAttrs, Structure3dSource } from '../types';
import { binaryCoordinateBytes } from '../../../../../shared/binary-coordinates';
import type { StructureFetchIdentity } from './structureData';
import { fullPdbEntryIdentity, shouldLoadFullPdbEntryForScene } from './scopedPdbSceneUpgrade';

export interface MolstarSourceProps {
  pdbId?: string;
  uniprotId?: string;
  url?: string;
  structureData?: string | Uint8Array;
  coordinateModel?: Structure3dAttrs['coordinateModel'];
  structureIdentity?: StructureFetchIdentity;
}

export function getMolstarPropsFromAttrs(
  source: Structure3dSource,
  attrs: Pick<
    Structure3dAttrs,
    | 'sourceId'
    | 'providerIdentityKey'
    | 'pdbId'
    | 'pdbEntityId'
    | 'labelAsymIds'
    | 'authAsymIds'
    | 'assemblyId'
    | 'uniprotId'
    | 'accession'
    | 'fragment'
    | 'version'
    | 'modelId'
    | 'url'
    | 'scene'
    | 'coordinateModel'
    | 'coordinateFormat'
  >
): MolstarSourceProps {
  switch (source) {
    case 'pdb': {
      const scoped = parseScopedRcsbSource(attrs.sourceId);
      const pdbId = scoped?.pdbId || normalizeRawPdbSource(attrs.sourceId) || attrs.pdbId;
      if (!pdbId) return {};
      const pdbEntityId = attrs.pdbEntityId ?? scoped?.pdbEntityId;
      const labelAsymIds = attrs.labelAsymIds ?? scoped?.labelAsymIds;
      const authAsymIds = attrs.authAsymIds ?? scoped?.authAsymIds;
      const loadFullEntry = shouldLoadFullPdbEntryForScene({
        ...attrs,
        source,
        pdbId,
        pdbEntityId,
        labelAsymIds,
        authAsymIds,
      });
      const providerIdentityKey =
        attrs.providerIdentityKey || scoped?.externalId || fullPdbEntryIdentity(pdbId);
      return {
        pdbId,
        structureIdentity: {
          provider: 'rcsb',
          externalId: providerIdentityKey,
          ...(loadFullEntry ? { fetchExternalId: fullPdbEntryIdentity(pdbId) } : {}),
          pdbId,
          ...(pdbEntityId ? { pdbEntityId } : {}),
          ...(labelAsymIds ? { labelAsymIds } : {}),
          ...(authAsymIds ? { authAsymIds } : {}),
          ...((attrs.assemblyId ?? scoped?.assemblyId)
            ? { assemblyId: attrs.assemblyId ?? scoped?.assemblyId }
            : {}),
        },
      };
    }
    case 'alphafold': {
      const accession =
        normalizeRawUniProtSource(attrs.sourceId) || attrs.uniprotId || attrs.accession;
      if (!accession) return {};
      const fragment = attrs.fragment || 'F1';
      const version = attrs.version || 'LATEST';
      const baseExternalId =
        attrs.providerIdentityKey || `AF:${accession.toUpperCase()}:${fragment}:${version}`;
      const externalId =
        attrs.modelId && !/:MODEL:/i.test(baseExternalId)
          ? `${baseExternalId}:MODEL:${attrs.modelId}`
          : baseExternalId;
      return {
        uniprotId: accession,
        structureIdentity: {
          provider: 'alphafold',
          externalId,
          accession,
          fragment,
          version,
          modelId: attrs.modelId,
        },
      };
    }
    case 'url':
      return { url: attrs.sourceId || attrs.url };
    case 'file':
      return {
        structureData:
          attrs.coordinateFormat === 'bcif' && attrs.sourceId
            ? binaryCoordinateBytes(attrs.sourceId)
            : attrs.sourceId,
        coordinateModel: attrs.coordinateModel,
      };
    default:
      return { pdbId: attrs.sourceId };
  }
}

function normalizeRawPdbSource(sourceId: string | undefined): string | undefined {
  if (!sourceId) return undefined;
  if (/^RCSB:/i.test(sourceId)) return undefined;
  return sourceId.toUpperCase();
}

interface ScopedRcsbSource {
  externalId: string;
  pdbId: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;
}

function parseScopedRcsbSource(sourceId: string | undefined): ScopedRcsbSource | undefined {
  if (!sourceId || !/^RCSB:/i.test(sourceId)) return undefined;
  const parts = sourceId.trim().split(':');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'RCSB' || parts[2].toUpperCase() !== 'ENTRY') {
    return undefined;
  }
  const pdbId = parts[1].toUpperCase();
  if (!/^[0-9][A-Z0-9]{3}$/.test(pdbId)) return undefined;
  if ((parts.length - 3) % 2 !== 0) return undefined;

  const scoped: ScopedRcsbSource = { externalId: `RCSB:${pdbId}:ENTRY`, pdbId };
  for (let index = 3; index + 1 < parts.length; index += 2) {
    const key = parts[index].toUpperCase();
    const value = parts[index + 1];
    if (key === 'ASSEMBLY') scoped.assemblyId = value.toUpperCase();
    else if (key === 'ENTITY') scoped.pdbEntityId = value.toUpperCase();
    else if (key === 'LABEL_ASYM') scoped.labelAsymIds = value.split(',');
    else if (key === 'AUTH_ASYM') scoped.authAsymIds = value.split(',');
    else return undefined;
    scoped.externalId = `${scoped.externalId}:${key}:${value}`;
  }
  return scoped;
}

function normalizeRawUniProtSource(sourceId: string | undefined): string | undefined {
  if (!sourceId) return undefined;
  const scoped = sourceId.match(/^AF:([A-Z0-9]+):F[0-9]+:(?:LATEST|V[0-9]+)/i);
  if (scoped) return scoped[1].toUpperCase();
  return sourceId.toUpperCase();
}
