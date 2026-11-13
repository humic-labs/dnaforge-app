import type { TabType, TabViewState } from '../../canvas/public/types';
import type { DBEntityReference } from '../../../db/entity-references';
import { resolveFilePathWithFallback } from '../../../hooks/resolveFilePath';
import { primerBindingToViewState } from '../../sequence/public/primer-binding-viewstate';
import { isSupportedSequencePath } from '../../../shared/scientific-file-types';

export interface ResolvedNavigation {
  tabType: TabType;
  entityId: string;
  label: string;
  viewState?: TabViewState;
  legacySequenceSourcePath?: string;
}

const ENTITY_TO_TAB: Record<string, TabType> = {
  file: 'file',
  sequence: 'sequence',
  sequence_region: 'sequence',
  annotation: 'sequence',
  primer: 'sequence',
  notebook: 'page',
  alignment: 'sequence',
  structure: 'structure',
  assembly: 'design',
  protein: 'protein',
};

export function parseLocatorPath(locator: string): string {
  const gitMatch = locator.match(/^git:\/\/(.+?)(?:@[a-f0-9]+)?$/);
  if (gitMatch) return gitMatch[1];

  const entityMatch = locator.match(/^entity:\/\/[^/]+\/(.+)$/);
  if (entityMatch) return entityMatch[1];

  return locator;
}

function stringDataField(data: string | null, field: string): string | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function buildViewState(
  entityType: string,
  deepLinkParams: Record<string, unknown> | null
): TabViewState | undefined {
  if (!deepLinkParams) return undefined;

  switch (entityType) {
    case 'sequence_region': {
      const start = deepLinkParams.start as number;
      const end = deepLinkParams.end as number;
      return {
        scrollPosition: start,
        highlightRange: {
          start: start - 1,
          end: end - 1,
          ...(deepLinkParams.wraps != null && { wraps: deepLinkParams.wraps as boolean }),
        },
      };
    }
    case 'annotation': {
      const start = deepLinkParams.start;
      const end = deepLinkParams.end;
      if (typeof start === 'number' && typeof end === 'number') {
        return {
          scrollPosition: start,
          highlightRange: {
            start: start - 1,
            end: end - 1,
            ...(end < start ? { wraps: true } : {}),
          },
        };
      }

      if (typeof deepLinkParams.featureStart === 'number') {
        return { scrollPosition: deepLinkParams.featureStart };
      }
      return undefined;
    }
    case 'primer': {
      const bindStart = deepLinkParams.bindingStart as number;
      const bindEnd = deepLinkParams.bindingEnd as number;
      return primerBindingToViewState(bindStart, bindEnd);
    }
    default:
      return Object.keys(deepLinkParams).length > 0 ? (deepLinkParams as TabViewState) : undefined;
  }
}

export function resolveReference(ref: DBEntityReference): ResolvedNavigation {
  let tabType = ENTITY_TO_TAB[ref.entity_type];
  if (
    ref.locator.startsWith('git://') &&
    (ref.entity_type === 'notebook' || ref.entity_type === 'alignment')
  ) {
    tabType = 'text';
  }
  if (!tabType) {
    console.warn(`[resolver] Unknown entity_type "${ref.entity_type}", falling back to "file"`);
  }
  let entityId = parseLocatorPath(ref.locator);
  let legacySequenceSourcePath: string | undefined;
  const isSequenceReference =
    ref.entity_type === 'sequence' ||
    ref.entity_type === 'sequence_region' ||
    ref.entity_type === 'annotation' ||
    ref.entity_type === 'primer';

  const dataDocumentId =
    stringDataField(ref.data, 'documentId') ?? stringDataField(ref.data, 'targetDocumentId');
  const isCanonicalFileProtein =
    ref.entity_type === 'protein' && ref.locator.startsWith('git://') && dataDocumentId !== null;
  if ((isSequenceReference || isCanonicalFileProtein) && dataDocumentId) entityId = dataDocumentId;
  const legacyPrimerTargetPath =
    ref.entity_type === 'primer' && !dataDocumentId
      ? stringDataField(ref.data, 'targetPath')
      : null;
  if (legacyPrimerTargetPath) {
    legacySequenceSourcePath = resolveFilePathWithFallback(legacyPrimerTargetPath);
  }

  if (ref.locator.startsWith('git://')) {
    if (!isCanonicalFileProtein) {
      const resolvedPath = resolveFilePathWithFallback(parseLocatorPath(ref.locator));
      if (isSequenceReference) legacySequenceSourcePath = resolvedPath;
      else entityId = resolvedPath;
    }
  }
  if (isSequenceReference && !dataDocumentId && isSupportedSequencePath(entityId)) {
    legacySequenceSourcePath = resolveFilePathWithFallback(entityId);
  }

  let deepLinkParams: Record<string, unknown> | null = null;
  if (ref.deep_link_params) {
    try {
      deepLinkParams = JSON.parse(ref.deep_link_params);
    } catch {}
  }
  const viewState = buildViewState(ref.entity_type, deepLinkParams);

  return {
    tabType: tabType ?? 'file',
    entityId,
    label: ref.display_label,
    viewState,
    ...(legacySequenceSourcePath ? { legacySequenceSourcePath } : {}),
  };
}
