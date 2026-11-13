import type { TrackAssetLocatorV1 } from '@waypoint/genome-data';

export type IndexedRangeSourceInput =
  | Readonly<{ kind: 'path'; path: string }>
  | Readonly<{ kind: 'url'; url: string; authRef?: string }>
  | Readonly<{
      kind: 's3';
      bucket: string;
      key: string;
      region?: string;
      requesterPays?: boolean;
      authRef?: string;
    }>
  | Readonly<{
      kind: 'gcs';
      bucket: string;
      object: string;
      billingProject?: string;
      authRef?: string;
    }>;

export function indexedRangeSourceFromTrackLocator(
  source: TrackAssetLocatorV1
): IndexedRangeSourceInput {
  switch (source.kind) {
    case 'local-file':
      return { kind: 'path', path: source.path };
    case 'http':
      return {
        kind: 'url',
        url: source.url,
        ...(source.authRef ? { authRef: source.authRef } : {}),
      };
    case 's3':
      return { ...source };
    case 'gcs':
      return { ...source };
    case 'htsget':
      throw new Error('htsget sources use the regional ticket runtime, not byte-range admission.');
  }
}
