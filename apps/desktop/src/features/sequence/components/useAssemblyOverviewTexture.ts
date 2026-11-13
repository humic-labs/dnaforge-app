import { useEffect, useRef, useState } from 'react';
import type { GenomeAssembly } from '@waypoint/genome-data';
import type {
  AssemblyOverviewTextureManifest,
  AssemblyTextureReadRequest,
} from '../../../shared/indexed-genome';
import { platform } from '../../../platform';
import { assemblyAnnotationSourceRequest } from '../assembly-annotation-source-request';

export interface AssemblyOverviewTexture {
  image: ImageBitmap;
  manifest: AssemblyOverviewTextureManifest;
}

export type AssemblyOverviewTextureStatus =
  | 'not-applicable'
  | 'loading'
  | 'loaded'
  | 'miss'
  | 'error';

export interface AssemblyOverviewTextureState {
  status: AssemblyOverviewTextureStatus;
  texture: AssemblyOverviewTexture | null;
  request: AssemblyTextureReadRequest | null;
  error: unknown | null;
}

const notApplicableAssemblyOverviewTextureState: AssemblyOverviewTextureState = {
  status: 'not-applicable',
  texture: null,
  request: null,
  error: null,
};

export function assemblyOverviewTextureReadRequestForAssembly(
  assembly: GenomeAssembly | undefined,
  workspaceRoot: string | null | undefined
): AssemblyTextureReadRequest | null {
  return assemblyAnnotationSourceRequest(assembly, workspaceRoot);
}

export function useAssemblyOverviewTexture(
  assembly: GenomeAssembly | undefined,
  workspaceRoot: string | null | undefined
): AssemblyOverviewTextureState {
  const [state, setState] = useState<AssemblyOverviewTextureState>(
    notApplicableAssemblyOverviewTextureState
  );
  const liveBitmapRef = useRef<ImageBitmap | null>(null);

  useEffect(() => {
    const closeLive = () => {
      liveBitmapRef.current?.close?.();
      liveBitmapRef.current = null;
    };
    if (!assembly || !workspaceRoot) {
      closeLive();
      setState(notApplicableAssemblyOverviewTextureState);
      return;
    }
    const request = assemblyOverviewTextureReadRequestForAssembly(assembly, workspaceRoot);
    if (!request) {
      closeLive();
      setState(notApplicableAssemblyOverviewTextureState);
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', texture: null, request, error: null });

    void (async () => {
      try {
        const result = await platform().genome.readAssemblyOverviewTexture(request);
        if (cancelled) return;
        if (!result) {
          closeLive();
          setState({ status: 'miss', texture: null, request, error: null });
          return;
        }
        const blob = await (await fetch(`data:image/png;base64,${result.pngBase64}`)).blob();
        const image = await createImageBitmap(blob, { imageOrientation: 'flipY' });
        if (cancelled) {
          image.close?.();
          return;
        }
        closeLive();
        liveBitmapRef.current = image;
        setState({
          status: 'loaded',
          texture: { image, manifest: result.manifest },
          request,
          error: null,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[assembly-overview-texture] read/decode failed', err);
        if (!cancelled) {
          closeLive();
          setState({ status: 'error', texture: null, request, error: err });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assembly, workspaceRoot]);

  return state;
}
