import type {
  ResolverResult,
  StructureCandidate,
  StructureDrawerRequest,
  StructureRef,
} from '../types/structure-drawer';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import {
  structureViewStateForScene,
  type StructureViewRenderIntent,
} from '../../page/public/embeds/structure3d/utils/structureRenderModel';
import { getStructureKey } from '../../page/public/embeds/structure3d/molstar/cache';
import { buildSingleQueryStructureScene } from './structure-scene';
import { createStructureBinding, createStructureViewIdentity } from './structure-view-identity';

export interface ResolverResultToAttrs {
  structureId: string;
  attrs: Structure3dAttrs;
  label: string;
}

export interface ResolverResultToStructureAttrsOptions {
  renderIntent?: StructureViewRenderIntent;
  linkOwnerId?: string;
  logicalViewOwnerId?: string;
}

export function resolverResultToStructureAttrs(
  resolved: ResolverResult,
  cdsLabel: string | undefined,
  request?: StructureDrawerRequest,
  options: ResolverResultToStructureAttrsOptions = {}
): ResolverResultToAttrs {
  const candidate = candidateForResolvedStructure(resolved);
  switch (resolved.structure.kind) {
    case 'pdb': {
      const pdbId = resolved.structure.pdbId.toUpperCase();
      const providerIdentityKey =
        resolved.structure.providerIdentityKey ??
        candidate?.provenance.structureIdentity?.providerIdentityKey ??
        `RCSB:${pdbId}:ENTRY`;
      const label = cdsLabel ?? candidate?.label ?? pdbId;
      return withSingleQueryScene(
        {
          structureId: `structure:${candidate?.id ?? providerIdentityKey}`,
          attrs: {
            source: 'pdb',
            sourceId: providerIdentityKey,
            providerIdentityKey,
            pdbId,
            ...(resolved.structure.pdbEntityId
              ? { pdbEntityId: resolved.structure.pdbEntityId }
              : {}),
            ...(resolved.structure.labelAsymIds
              ? { labelAsymIds: [...resolved.structure.labelAsymIds] }
              : {}),
            ...(resolved.structure.authAsymIds
              ? { authAsymIds: [...resolved.structure.authAsymIds] }
              : {}),
            ...(resolved.structure.assemblyId ? { assemblyId: resolved.structure.assemblyId } : {}),
            label,
            ...candidateMetadataAttrs(candidate),
            representation: 'cartoon',
            colorMode: 'chain',
          },
          label,
        },
        resolved,
        candidate,
        request,
        options
      );
    }
    case 'uniprot': {
      const accession = resolved.structure.accession.toUpperCase();
      const fragment = resolved.structure.fragment ?? 'F1';
      const version = resolved.structure.version ?? 'LATEST';
      const providerIdentityKey =
        resolved.structure.providerIdentityKey ??
        candidate?.provenance.structureIdentity?.providerIdentityKey ??
        `AF:${accession}:${fragment}:${version}`;
      const label = cdsLabel ?? candidate?.label ?? accession;
      return withSingleQueryScene(
        {
          structureId: `structure:${candidate?.id ?? providerIdentityKey}`,
          attrs: {
            source: 'alphafold',
            sourceId: providerIdentityKey,
            providerIdentityKey,
            uniprotId: accession,
            accession,
            fragment,
            version,
            ...(resolved.structure.modelId ? { modelId: resolved.structure.modelId } : {}),
            label,
            ...candidateMetadataAttrs(candidate),
            representation: 'cartoon',
            colorMode: 'plddt',
          },
          label,
        },
        resolved,
        candidate,
        request,
        options
      );
    }
    case 'url': {
      const label = cdsLabel ?? labelFromUrl(resolved.structure.url);
      return withSingleQueryScene(
        {
          structureId: getStructureKey(undefined, undefined, resolved.structure.url),
          attrs: {
            source: 'url',
            sourceId: resolved.structure.url,
            url: resolved.structure.url,
            label,
            representation: 'cartoon',
            colorMode: 'chain',
          },
          label,
        },
        resolved,
        candidate,
        request,
        options
      );
    }
    case 'data': {
      const label = cdsLabel ?? `Inline ${resolved.structure.format.toUpperCase()}`;
      return withSingleQueryScene(
        {
          structureId: getStructureKey(
            undefined,
            undefined,
            undefined,
            resolved.structure.data,
            undefined,
            undefined,
            resolved.structure.coordinateModel
          ),
          attrs: {
            source: 'file',
            sourceId: resolved.structure.data,
            coordinateModel: resolved.structure.coordinateModel,
            catalogProvenance: resolved.structure.catalogProvenance,
            ...(resolved.structure.labelAsymIds
              ? { labelAsymIds: resolved.structure.labelAsymIds }
              : {}),
            label,
            representation: 'cartoon',
            colorMode: 'chain',
          },
          label,
        },
        resolved,
        candidate,
        request,
        options
      );
    }
  }
}

function withSingleQueryScene(
  result: ResolverResultToAttrs,
  resolved: ResolverResult,
  candidate: StructureCandidate | null,
  request: StructureDrawerRequest | undefined,
  options: ResolverResultToStructureAttrsOptions
): ResolverResultToAttrs {
  const attrsWithScene: Structure3dAttrs = {
    ...result.attrs,
    scene: buildSingleQueryStructureScene({
      resolved,
      candidate,
      structureId: result.structureId,
      attrs: result.attrs,
      label: result.label,
      request,
    }),
  };

  const attrsWithView: Structure3dAttrs = {
    ...attrsWithScene,
    view: structureViewStateForScene(attrsWithScene, {
      renderIntent: options.renderIntent ?? 'loaded',
    }),
  };
  const binding = request?.proteinIdentity?.sequence.digests.sha256
    ? createStructureBinding({
        structureId: result.structureId,
        attrs: attrsWithView,
        request,
        linkOwnerId: options.linkOwnerId,
      })
    : undefined;
  const structureViewIdentity = binding
    ? createStructureViewIdentity(
        binding,
        options.logicalViewOwnerId ??
          request?.identityRequestKey ??
          options.linkOwnerId ??
          binding.bindingId
      )
    : undefined;

  return {
    ...result,
    attrs: {
      ...attrsWithView,
      ...(binding ? { structureBinding: binding } : {}),
      ...(structureViewIdentity ? { structureViewIdentity } : {}),
    },
  };
}

function candidateForResolvedStructure(resolved: ResolverResult): StructureCandidate | null {
  const candidates = resolved.candidates ?? [];
  return (
    candidates.find((candidate) => sameStructureRef(candidate.structure, resolved.structure)) ??
    null
  );
}

function sameStructureRef(left: StructureRef, right: StructureRef): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'pdb':
      return (
        right.kind === 'pdb' &&
        (left.providerIdentityKey && right.providerIdentityKey
          ? left.providerIdentityKey === right.providerIdentityKey
          : left.pdbId.toUpperCase() === right.pdbId.toUpperCase())
      );
    case 'uniprot':
      return (
        right.kind === 'uniprot' &&
        (left.providerIdentityKey && right.providerIdentityKey
          ? left.providerIdentityKey === right.providerIdentityKey
          : left.accession.toUpperCase() === right.accession.toUpperCase())
      );
    case 'url':
      return right.kind === 'url' && left.url === right.url;
    case 'data':
      return right.kind === 'data' && left.format === right.format && left.data === right.data;
  }
}

function candidateMetadataAttrs(candidate: StructureCandidate | null): Partial<Structure3dAttrs> {
  if (!candidate) return {};
  const attrs: Partial<Structure3dAttrs> = {};
  if (candidate.metadata.title !== undefined) attrs.title = candidate.metadata.title;
  if (candidate.metadata.description !== undefined) {
    attrs.description = candidate.metadata.description;
  }
  if (candidate.metadata.organism !== undefined) attrs.organism = candidate.metadata.organism;
  if (candidate.metadata.resolution !== undefined) attrs.resolution = candidate.metadata.resolution;
  if (candidate.metadata.method !== undefined) attrs.method = candidate.metadata.method;
  return attrs;
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  } catch {
    return 'Structure URL';
  }
}
