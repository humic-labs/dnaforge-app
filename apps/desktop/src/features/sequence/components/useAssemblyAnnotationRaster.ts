import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssemblyAnnotationRasterManifestV2,
  AssemblyAnnotationRasterReadRequestV2,
  AssemblyTextureReadRequest,
} from '../../../shared/indexed-genome';
import { platform } from '../../../platform';
import type { AssemblyAnnotationPolicyRequest } from './assembly-annotation-policy-transaction';

export interface AssemblyAnnotationRasterTexture {
  image: ImageBitmap;
  manifest: AssemblyAnnotationRasterManifestV2;
}

export type AssemblyAnnotationRasterStatus =
  | 'not-applicable'
  | 'loading'
  | 'loaded'
  | 'miss'
  | 'error';

export interface AssemblyAnnotationRasterState {
  status: AssemblyAnnotationRasterStatus;
  texture: AssemblyAnnotationRasterTexture | null;
  request: AssemblyAnnotationRasterReadRequestV2 | null;
  error: unknown | null;
}

interface AssemblyAnnotationRasterDescriptor {
  sourceIdentity: string;
  datasetContract: AssemblyAnnotationRasterReadRequestV2['datasetContract'];
}

interface UseAssemblyAnnotationRasterOptions {
  sourceRequest: AssemblyTextureReadRequest | null;
  descriptor: AssemblyAnnotationRasterDescriptor | null;
  isoformMode: AssemblyAnnotationRasterReadRequestV2['isoformMode'];
  laneLimit: number | null;
  themeMode: AssemblyAnnotationRasterReadRequestV2['themeMode'];
}

export interface AssemblyAnnotationRasterPolicy {
  isoformMode: AssemblyAnnotationRasterReadRequestV2['isoformMode'];
  laneLimit: number | null;
}

export type AssemblyAnnotationRasterPendingPreparation = {
  requestId: number;
  policy: AssemblyAnnotationRasterPolicy;
  status: 'loading' | 'ready' | 'miss' | 'error';
};

export interface AssemblyAnnotationRasterHandoffState {
  renderer: AssemblyAnnotationRasterState;
  pendingPreparation: AssemblyAnnotationRasterPendingPreparation | null;
}

interface UseAssemblyAnnotationRasterHandoffOptions {
  sourceRequest: AssemblyTextureReadRequest | null;
  descriptor: AssemblyAnnotationRasterDescriptor | null;
  committedPolicy: AssemblyAnnotationRasterPolicy;
  pendingRequest: AssemblyAnnotationPolicyRequest | null;
  themeMode: AssemblyAnnotationRasterReadRequestV2['themeMode'];
}

const NOT_APPLICABLE: AssemblyAnnotationRasterState = {
  status: 'not-applicable',
  texture: null,
  request: null,
  error: null,
};

export function assemblyAnnotationRasterReadRequest(
  options: UseAssemblyAnnotationRasterOptions
): AssemblyAnnotationRasterReadRequestV2 | null {
  if (!options.sourceRequest || !options.descriptor) return null;
  const descriptor = options.descriptor as Partial<AssemblyAnnotationRasterDescriptor>;
  if (
    !descriptor.sourceIdentity ||
    !descriptor.datasetContract?.datasetId ||
    !descriptor.datasetContract.datasetVersion ||
    !descriptor.datasetContract.sourceSha256
  ) {
    return null;
  }
  return {
    ...options.sourceRequest,
    datasetContract: descriptor.datasetContract,
    genomeIdentity: descriptor.sourceIdentity,
    trackType: 'mRNA',
    isoformMode: options.isoformMode,
    laneLimit: options.laneLimit,
    themeMode: options.themeMode,
  };
}

export function useAssemblyAnnotationRaster(
  options: UseAssemblyAnnotationRasterOptions
): AssemblyAnnotationRasterState {
  const request = useMemo(
    () => assemblyAnnotationRasterReadRequest(options),
    [
      options.descriptor?.datasetContract?.datasetId,
      options.descriptor?.datasetContract?.datasetVersion,
      options.descriptor?.datasetContract?.sourceSha256,
      options.descriptor?.sourceIdentity,
      options.isoformMode,
      options.laneLimit,
      options.sourceRequest,
      options.themeMode,
    ]
  );
  const [state, setState] = useState<AssemblyAnnotationRasterState>(NOT_APPLICABLE);
  const liveBitmapRef = useRef<ImageBitmap | null>(null);

  useEffect(() => {
    if (!request) {
      liveBitmapRef.current?.close?.();
      liveBitmapRef.current = null;
      setState(NOT_APPLICABLE);
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', texture: null, request, error: null });

    void (async () => {
      try {
        const result = await platform().genome.readAssemblyAnnotationRasterV2(request);
        if (cancelled) return;
        if (!result) {
          liveBitmapRef.current?.close?.();
          liveBitmapRef.current = null;
          setState({ status: 'miss', texture: null, request, error: null });
          return;
        }
        const blob = await (await fetch(`data:image/png;base64,${result.pngBase64}`)).blob();
        const image = await createImageBitmap(blob, { imageOrientation: 'flipY' });
        if (cancelled) {
          image.close?.();
          return;
        }
        liveBitmapRef.current?.close?.();
        liveBitmapRef.current = image;
        setState({
          status: 'loaded',
          texture: { image, manifest: result.manifest },
          request,
          error: null,
        });
      } catch (error) {
        if (!cancelled) {
          liveBitmapRef.current?.close?.();
          liveBitmapRef.current = null;
          setState({ status: 'error', texture: null, request, error });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(
    () => () => {
      liveBitmapRef.current?.close?.();
      liveBitmapRef.current = null;
    },
    []
  );

  return state;
}

type ResidentRaster = {
  request: AssemblyAnnotationRasterReadRequestV2;
  texture: AssemblyAnnotationRasterTexture;
};

type RasterLoadState = {
  requestKey: string | null;
  preparationRequestId: number | null;
  status: AssemblyAnnotationRasterStatus;
  error: unknown | null;
};

function rasterRequestKey(request: AssemblyAnnotationRasterReadRequestV2 | null): string | null {
  return request ? JSON.stringify(request) : null;
}

export function useAssemblyAnnotationRasterHandoff(
  options: UseAssemblyAnnotationRasterHandoffOptions
): AssemblyAnnotationRasterHandoffState {
  const committedRequest = useMemo(
    () =>
      assemblyAnnotationRasterReadRequest({
        sourceRequest: options.sourceRequest,
        descriptor: options.descriptor,
        isoformMode: options.committedPolicy.isoformMode,
        laneLimit: options.committedPolicy.laneLimit,
        themeMode: options.themeMode,
      }),
    [
      options.committedPolicy.isoformMode,
      options.committedPolicy.laneLimit,
      options.descriptor?.datasetContract?.datasetId,
      options.descriptor?.datasetContract?.datasetVersion,
      options.descriptor?.datasetContract?.sourceSha256,
      options.descriptor?.sourceIdentity,
      options.sourceRequest,
      options.themeMode,
    ]
  );
  const desiredPolicy = options.pendingRequest?.policy ?? options.committedPolicy;
  const desiredPreparationRequestId = options.pendingRequest?.requestId ?? null;
  const desiredRequest = useMemo(
    () =>
      assemblyAnnotationRasterReadRequest({
        sourceRequest: options.sourceRequest,
        descriptor: options.descriptor,
        isoformMode: desiredPolicy.isoformMode,
        laneLimit: desiredPolicy.laneLimit,
        themeMode: options.themeMode,
      }),
    [
      desiredPolicy.isoformMode,
      desiredPolicy.laneLimit,
      options.descriptor?.datasetContract?.datasetId,
      options.descriptor?.datasetContract?.datasetVersion,
      options.descriptor?.datasetContract?.sourceSha256,
      options.descriptor?.sourceIdentity,
      options.sourceRequest,
      options.themeMode,
    ]
  );
  const committedKey = rasterRequestKey(committedRequest);
  const desiredKey = rasterRequestKey(desiredRequest);
  const residentsRef = useRef(new Map<string, ResidentRaster>());
  const [loadState, setLoadState] = useState<RasterLoadState>({
    requestKey: null,
    preparationRequestId: null,
    status: 'not-applicable',
    error: null,
  });

  useEffect(() => {
    if (!desiredRequest || !desiredKey) {
      setLoadState({
        requestKey: null,
        preparationRequestId: desiredPreparationRequestId,
        status: 'not-applicable',
        error: null,
      });
      return;
    }
    if (residentsRef.current.has(desiredKey)) {
      setLoadState({
        requestKey: desiredKey,
        preparationRequestId: desiredPreparationRequestId,
        status: 'loaded',
        error: null,
      });
      return;
    }
    let cancelled = false;
    setLoadState({
      requestKey: desiredKey,
      preparationRequestId: desiredPreparationRequestId,
      status: 'loading',
      error: null,
    });
    void (async () => {
      try {
        const result = await platform().genome.readAssemblyAnnotationRasterV2(desiredRequest);
        if (cancelled) return;
        if (!result) {
          setLoadState({
            requestKey: desiredKey,
            preparationRequestId: desiredPreparationRequestId,
            status: 'miss',
            error: null,
          });
          return;
        }
        const blob = await (await fetch(`data:image/png;base64,${result.pngBase64}`)).blob();
        const image = await createImageBitmap(blob, { imageOrientation: 'flipY' });
        if (cancelled) {
          image.close?.();
          return;
        }
        residentsRef.current.set(desiredKey, {
          request: desiredRequest,
          texture: { image, manifest: result.manifest },
        });
        setLoadState({
          requestKey: desiredKey,
          preparationRequestId: desiredPreparationRequestId,
          status: 'loaded',
          error: null,
        });
      } catch (error) {
        if (!cancelled) {
          setLoadState({
            requestKey: desiredKey,
            preparationRequestId: desiredPreparationRequestId,
            status: 'error',
            error,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desiredKey, desiredPreparationRequestId, desiredRequest]);

  useEffect(() => {
    const retainedKeys = new Set([committedKey, desiredKey].filter((key): key is string => !!key));
    for (const [key, resident] of residentsRef.current) {
      if (retainedKeys.has(key)) continue;
      resident.texture.image.close?.();
      residentsRef.current.delete(key);
    }
  }, [committedKey, desiredKey]);

  useEffect(
    () => () => {
      for (const resident of residentsRef.current.values()) {
        resident.texture.image.close?.();
      }
      residentsRef.current.clear();
    },
    []
  );

  const stateFor = (
    request: AssemblyAnnotationRasterReadRequestV2 | null,
    key: string | null,
    preparationRequestId: number | null
  ): AssemblyAnnotationRasterState => {
    if (!request || !key) return NOT_APPLICABLE;
    const resident = residentsRef.current.get(key);
    if (resident) {
      return {
        status: 'loaded',
        texture: resident.texture,
        request,
        error: null,
      };
    }
    const loadStateMatchesAttempt =
      loadState.requestKey === key && loadState.preparationRequestId === preparationRequestId;
    return {
      status: loadStateMatchesAttempt ? loadState.status : 'loading',
      texture: null,
      request,
      error: loadStateMatchesAttempt ? loadState.error : null,
    };
  };

  const committedState = stateFor(committedRequest, committedKey, null);
  const desiredState = stateFor(desiredRequest, desiredKey, desiredPreparationRequestId);
  const pendingPreparation = options.pendingRequest
    ? {
        requestId: options.pendingRequest.requestId,
        policy: { ...options.pendingRequest.policy },
        status:
          desiredState.status === 'loaded'
            ? ('ready' as const)
            : desiredState.status === 'miss' || desiredState.status === 'error'
              ? desiredState.status
              : ('loading' as const),
      }
    : null;

  return {
    renderer:
      options.pendingRequest && desiredState.status === 'loaded' ? desiredState : committedState,
    pendingPreparation,
  };
}
