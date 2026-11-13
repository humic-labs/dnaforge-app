import { stripDisplayExtension } from '@/utils/fileTypes';
import type { Structure3dAttrs } from '../types';

export function structureKeyOverrideForAttrs(data: Structure3dAttrs): string | undefined {
  if (data.structureArtifactRef?.structureId) return data.structureArtifactRef.structureId;
  if (data.coordinateSha256 && data.molViewSpecAssets?.length)
    return `saved-comparison:sha256:${[
      data.coordinateSha256,
      ...data.molViewSpecAssets.map((asset) => asset.sha256),
    ].join(':')}`;
  if (data.coordinateSha256)
    return `saved-coordinate:sha256:${data.coordinateSha256}${data.coordinateModel && (data.coordinateModel.blockIndex || data.coordinateModel.modelIndex) ? `:block:${data.coordinateModel.blockIndex}:model:${data.coordinateModel.modelIndex}` : ''}`;
  return undefined;
}

export function structureSourceIdentityKey(data: Structure3dAttrs): string {
  const labels = (data.labelAsymIds ?? []).slice().sort();
  const auths = (data.authAsymIds ?? []).slice().sort();
  const pinnedDigest = data.coordinateSha256;
  return [
    `source:${data.source ?? ''}`,
    `sourceId:${pinnedDigest ? '' : (data.sourceId ?? '')}`,
    `coordinateDigest:${pinnedDigest ?? ''}`,
    `coordinateModel:${data.coordinateModel ? JSON.stringify(data.coordinateModel) : ''}`,
    `pinnedAssets:${data.molViewSpecAssets?.map((asset) => `${asset.name}:${asset.sha256}`).join(',') ?? ''}`,
    `providerIdentity:${data.providerIdentityKey ?? ''}`,
    `pdbId:${data.pdbId ?? ''}`,
    `entity:${data.pdbEntityId ?? ''}`,
    `label:${labels.join(',')}`,
    `auth:${auths.join(',')}`,
    `assembly:${data.assemblyId ?? ''}`,
    `uniprot:${data.uniprotId ?? ''}`,
    `accession:${data.accession ?? ''}`,
    `fragment:${data.fragment ?? ''}`,
    `version:${data.version ?? ''}`,
    `model:${data.modelId ?? ''}`,
    `url:${data.url ?? ''}`,
    `structureData:${pinnedDigest ? '' : (data.structureData ?? '')}`,
  ].join('|');
}

export function structureHeaderText(data: Structure3dAttrs): { label: string; title?: string } {
  const label = stripDisplayExtension(data.label || data.sourceId || '');
  const title = data.title ? stripDisplayExtension(data.title) : undefined;
  return { label, title: title && title !== label ? title : undefined };
}
