import {
  isPortableNativeEntityId,
  nativeEntityReferenceHref,
  nativeEntityReferenceIdFromElement,
  nativeEntityReferenceIdFromHref,
} from '../../../shared/native-entity-reference';
import {
  isExactProviderStableId,
  isSafeProviderCanonicalUrl,
  type ProviderObjectClass,
} from '../../../shared/provider-object-reference';
import { platform } from '../../../platform';
import {
  dispatchReferenceEvent,
  referenceIntent,
  type ReferenceIntent,
} from '../entity-ref/reference-workflow';

export {
  nativeEntityReferenceHref,
  nativeEntityReferenceIdFromElement,
  nativeEntityReferenceIdFromHref,
};

export type OpenNativeEntityReferenceDetail = {
  entityId: string;
  label: string;
  owningRoot: string | null;
};

export type CatalogEntityOpenReceipt = Parameters<ReferenceIntent['finish']>[0];

export type OpenExactCatalogEntityDetail = {
  entityId: string;
  label: string;
  owningRoot: string;
  onResult?: (result: CatalogEntityOpenReceipt) => void;
};

export type ViewOriginalNativeEntitySourceDetail = {
  workspaceId: number;
  entityId: string;
  sourceRecordId: string;
  label: string;
};

export type ImportedProviderReferenceInput = {
  stableObjectId: string;
  objectClass: ProviderObjectClass;
  href: string | null;
  label: string;
  owningRoot: string | null;
};

export type ImportedProviderReferenceDestination =
  | { kind: 'native'; detail: OpenNativeEntityReferenceDetail }
  | { kind: 'benchling'; url: string }
  | { kind: 'none' };

export function dispatchOpenNativeEntityReference(
  detail: OpenNativeEntityReferenceDetail,
  inherited?: ReferenceIntent
): boolean {
  const intent = inherited ?? referenceIntent({});
  if (!isPortableNativeEntityId(detail.entityId)) {
    intent.finish({ kind: 'failure', reason: 'unsupported' });
    return false;
  }
  dispatchReferenceEvent(
    {
      entityType: 'native-catalog',
      entityId: detail.entityId,
      label: detail.label,
      owningRoot: detail.owningRoot,
    },
    intent
  );
  return true;
}

export function dispatchOpenExactCatalogEntity(detail: OpenExactCatalogEntityDetail): boolean {
  let settled = false;
  const report = (result: CatalogEntityOpenReceipt) => {
    if (settled) return;
    settled = true;
    detail.onResult?.(result);
  };
  const intent: ReferenceIntent = detail.onResult
    ? {
        get finished() {
          return settled;
        },
        finish: report,
      }
    : referenceIntent({});
  if (!isPortableNativeEntityId(detail.entityId) || !detail.owningRoot) {
    intent.finish({
      kind: 'failure',
      reason: detail.owningRoot ? 'unsupported' : 'missing_owner',
    });
    return false;
  }
  const accepted = dispatchReferenceEvent(
    {
      entityType: 'native-catalog-exact',
      entityId: detail.entityId,
      label: detail.label,
      owningRoot: detail.owningRoot,
    },
    intent
  );
  return detail.onResult ? accepted : true;
}

export function dispatchViewOriginalNativeEntitySource(
  detail: ViewOriginalNativeEntitySourceDetail
): boolean {
  if (
    !isPortableNativeEntityId(detail.entityId) ||
    !Number.isSafeInteger(detail.workspaceId) ||
    detail.workspaceId <= 0 ||
    !isExactProviderStableId(detail.sourceRecordId)
  ) {
    return false;
  }
  window.dispatchEvent(new CustomEvent('waypoint:view-original-provider-source', { detail }));
  return true;
}

export function isNewTabClick(event: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
}): boolean {
  return Boolean(
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1
  );
}

export async function resolveImportedProviderReferenceDestination(
  input: ImportedProviderReferenceInput
): Promise<ImportedProviderReferenceDestination> {
  const fallback = (): ImportedProviderReferenceDestination =>
    isSafeProviderCanonicalUrl(input.href)
      ? { kind: 'benchling', url: input.href }
      : { kind: 'none' };

  if (!input.owningRoot) return fallback();

  try {
    const result = await platform().benchlingMigration.resolveProviderReference({
      workspaceRoot: input.owningRoot,
      reference: {
        provider: 'benchling',
        stableObjectId: input.stableObjectId,
        objectClass: input.objectClass,
        canonicalUrl: input.href,
        providerAccountHint: null,
      },
      sourceUrl: input.href,
    });
    if (
      result.resolution.status === 'resolved' &&
      isPortableNativeEntityId(result.resolution.entityId)
    ) {
      return {
        kind: 'native',
        detail: {
          entityId: result.resolution.entityId,
          label: input.label,
          owningRoot: input.owningRoot,
        },
      };
    }
    return fallback();
  } catch {
    return fallback();
  }
}

export async function openImportedProviderReference(
  input: ImportedProviderReferenceInput & {
    openFallbackUrl?: (url: string) => void;
  }
): Promise<'native' | 'external' | 'none'> {
  const intent = referenceIntent({});
  const openFallbackUrl =
    input.openFallbackUrl ?? ((url: string) => window.open(url, '_blank', 'noopener,noreferrer'));
  const destination = await resolveImportedProviderReferenceDestination(input);
  switch (destination.kind) {
    case 'native':
      return dispatchOpenNativeEntityReference(destination.detail, intent) ? 'native' : 'none';
    case 'benchling':
      try {
        openFallbackUrl(destination.url);
        intent.finish({ kind: 'provider_requested' });
      } catch (error) {
        intent.finish({ kind: 'failure', reason: 'open_failed' });
        throw error;
      }
      return 'external';
    case 'none':
      intent.finish({ kind: 'failure', reason: 'provider_unavailable' });
      return 'none';
  }
}
