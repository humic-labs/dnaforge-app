import { throwStructureError } from './errors';
import { useStructureDrawerStore } from '../../structure-drawer/public';
import type { StructureRef } from '../../structure-drawer/public/types/structure-drawer';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import { fetchStructureData } from '../../page/public/embeds/structure3d/utils/structureData';
import { validateAlphaFoldId } from '../../page/public/embeds/structure3d/api/structure-service-client';
import type { StructureSourceInput } from './contracts';

function errorField(error: unknown, field: 'code' | 'message'): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>).statusCode;
  return typeof value === 'number' ? value : undefined;
}

function isMissingBioinfoResource(error: unknown): boolean {
  const code = errorField(error, 'code');
  return code === 'NOT_FOUND' || code === 'INVALID_ID' || errorStatusCode(error) === 404;
}

function preflightErrorDetails(id: string, error: unknown): Record<string, unknown> {
  return {
    id,
    cause: errorField(error, 'message') ?? (error instanceof Error ? error.message : String(error)),
    bioinfoCode: errorField(error, 'code') ?? null,
    statusCode: errorStatusCode(error) ?? null,
  };
}

function rethrowStructurePreflightError(
  kind: 'pdb' | 'uniprot',
  id: string,
  error: unknown
): never {
  if ((error as Error).name === 'AbortError') {
    throw error;
  }
  if (isMissingBioinfoResource(error)) {
    if (kind === 'pdb') {
      throwStructureError('PDB_NOT_FOUND', `PDB ID not found: ${id}.`, {
        pdbId: id,
        ...preflightErrorDetails(id, error),
      });
    }
    throwStructureError('UNIPROT_NOT_FOUND', `UniProt accession not found: ${id}.`, {
      accession: id,
      ...preflightErrorDetails(id, error),
    });
  }

  throwStructureError(
    'MOLSTAR_RUNTIME_ERROR',
    `Could not validate ${kind === 'pdb' ? 'PDB' : 'UniProt'} structure source.`,
    preflightErrorDetails(id, error),
    true
  );
}

export async function preflightStructureSource(
  structure: StructureSourceInput,
  signal?: AbortSignal
): Promise<Partial<Structure3dAttrs> | null> {
  throwIfAborted(signal);
  if (structure.kind === 'pdb') {
    const pdbId = structure.pdbId.toUpperCase();
    try {
      await fetchStructureDataWithOptionalSignal(pdbId, 'rcsb', signal);
      throwIfAborted(signal);
      return null;
    } catch (error) {
      rethrowStructurePreflightError('pdb', pdbId, error);
    }
  } else if (structure.kind === 'uniprot') {
    const accession = structure.accession.toUpperCase();
    try {
      const validation = await validateAlphaFoldId(accession, signal);
      throwIfAborted(signal);
      if (!validation.valid) {
        throw Object.assign(new Error(`UniProt ID not found in AlphaFold: ${accession}`), {
          code: 'NOT_FOUND',
          statusCode: 404,
        });
      }
      return {
        sourceId: validation.providerIdentityKey ?? accession,
        providerIdentityKey: validation.providerIdentityKey,
        accession,
        fragment: validation.fragment ?? 'F1',
        version:
          validation.latestVersion !== undefined ? `V${validation.latestVersion}` : undefined,
        modelId: validation.modelId,
      };
    } catch (error) {
      rethrowStructurePreflightError('uniprot', accession, error);
    }
  }
  return null;
}

async function preflightResolvedStructureBytes(
  structure: StructureRef,
  signal?: AbortSignal
): Promise<void> {
  if (structure.kind === 'pdb') {
    const pdbId = structure.pdbId.toUpperCase();
    await fetchStructureDataWithOptionalSignal(
      {
        provider: 'rcsb',
        externalId: structure.providerIdentityKey ?? `RCSB:${pdbId}:ENTRY`,
        pdbId,
        pdbEntityId: structure.pdbEntityId,
        labelAsymIds: structure.labelAsymIds,
        authAsymIds: structure.authAsymIds,
        assemblyId: structure.assemblyId,
      },
      'rcsb',
      signal
    );
    return;
  }
  if (structure.kind === 'uniprot') {
    const accession = structure.accession.toUpperCase();
    const fragment = structure.fragment ?? 'F1';
    const version = structure.version ?? 'LATEST';
    await fetchStructureDataWithOptionalSignal(
      {
        provider: 'alphafold',
        externalId: structure.providerIdentityKey ?? `AF:${accession}:${fragment}:${version}`,
        accession,
        fragment,
        version,
        modelId: structure.modelId,
      },
      'alphafold',
      signal
    );
  }
}

function fetchStructureDataWithOptionalSignal(
  id: Parameters<typeof fetchStructureData>[0],
  provider: Parameters<typeof fetchStructureData>[1],
  signal?: AbortSignal
): ReturnType<typeof fetchStructureData> {
  return signal ? fetchStructureData(id, provider, signal) : fetchStructureData(id, provider);
}

export async function preflightResolvedStructureBytesWithFallback(
  requestId: number,
  structure: StructureRef,
  signal?: AbortSignal
): Promise<void> {
  try {
    throwIfAborted(signal);
    await preflightResolvedStructureBytes(structure, signal);
    throwIfAborted(signal);
    return;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      useStructureDrawerStore.getState().close();
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    useStructureDrawerStore.getState().handleViewerError(message, requestId);
    const next = useStructureDrawerStore.getState();
    const fallbackStructure = next.resolved?.structure;
    if (
      next.requestId === requestId &&
      next.status === 'rendering' &&
      fallbackStructure &&
      fallbackStructure !== structure
    ) {
      throwIfAborted(signal);
      await preflightResolvedStructureBytes(fallbackStructure, signal);
      throwIfAborted(signal);
      return;
    }
    throw error;
  }
}

function abortError(): Error {
  const error = new Error('Operation canceled.');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      try {
        onAbort();
      } finally {
        reject(abortError());
      }
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}
