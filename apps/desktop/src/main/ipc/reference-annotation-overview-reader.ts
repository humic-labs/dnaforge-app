import type { IndexedGenomeManifest } from '@waypoint/genome-data';

import type { GenomeSessionShell } from '../../shared/indexed-genome';
import {
  getCachedAnnotationOverviewTile,
  getCachedOrStartAnnotationOverviewTileBuild,
  type OverviewAnnotationTileBuildStatus,
  type OverviewAnnotationTilePayload,
} from './genome-overview-tile-cache';

interface ReferenceAnnotationOverviewReaderDeps {
  readonly readPrepared: typeof getCachedAnnotationOverviewTile;
  readonly readOrStart: typeof getCachedOrStartAnnotationOverviewTileBuild;
}

const DEFAULT_DEPS: ReferenceAnnotationOverviewReaderDeps = {
  readPrepared: getCachedAnnotationOverviewTile,
  readOrStart: getCachedOrStartAnnotationOverviewTileBuild,
};

export function annotationOverviewMayBeBuiltAtRuntime(
  session: Pick<
    GenomeSessionShell,
    | 'assemblySearchSource'
    | 'assemblyAssetGeneration'
    | 'assemblyAnnotationProductsReadiness'
    | 'preparedReferenceReadOnly'
  >
): boolean {
  return (
    session.preparedReferenceReadOnly !== true &&
    session.assemblyAnnotationProductsReadiness === undefined &&
    !session.assemblyAssetGeneration
  );
}

export async function readAnnotationOverviewForSession(
  input: {
    session: Pick<
      GenomeSessionShell,
      | 'assemblySearchSource'
      | 'assemblyAssetGeneration'
      | 'assemblyAnnotationProductsReadiness'
      | 'preparedReferenceReadOnly'
    >;
    manifest: IndexedGenomeManifest;
    buildOverviewTile: () => Promise<OverviewAnnotationTilePayload>;
  },
  deps: ReferenceAnnotationOverviewReaderDeps = DEFAULT_DEPS
): Promise<OverviewAnnotationTileBuildStatus> {
  if (annotationOverviewMayBeBuiltAtRuntime(input.session)) {
    return deps.readOrStart({
      manifest: input.manifest,
      buildOverviewTile: input.buildOverviewTile,
    });
  }
  const prepared = await deps.readPrepared({ manifest: input.manifest });
  if (!prepared) {
    throw new Error('[genome] Required prepared reference annotation overview is unavailable.');
  }
  return { status: 'cached', result: prepared };
}
