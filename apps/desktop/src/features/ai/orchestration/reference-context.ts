import { getEntityReferencesByIds, type DBEntityReference } from '../../../db/entity-references';
import { REF_TOKEN_PATTERN } from '../references/constants';
import { hasCompleteStructureResidueIdentities } from '../selection-descriptor/structure';
import { nextPromptFenceNonce, serializePromptDataFence } from './prompt-untrusted-data';
import { resolveMolecularReference } from '../../../shared/molecular-reference';
import { resolveMolecularReferenceSnapshot } from '../references/molecular';
import { summarizeSequenceReference } from './sequence-reference-summary';

function nextSelectionFenceNonce(): string {
  return nextPromptFenceNonce();
}

export function serializeReferenceDescriptorFence(
  ref: DBEntityReference,
  path: string,
  nonce: string
): string | null {
  if (!ref.data) return null;
  const subject = resolveMolecularReference(ref);
  const view = subject?.kind === 'visualization' ? subject.view : null;
  if (subject?.kind === 'view')
    return serializePromptDataFence(
      'wp-sel',
      {
        reference: {
          refId: ref.id,
          entityType: ref.entity_type,
          displayLabel: ref.display_label,
          path,
        },
        molecularTarget: subject.target,
      },
      nonce
    );
  if (view)
    return serializePromptDataFence(
      'wp-sel',
      {
        reference: {
          refId: ref.id,
          entityType: ref.entity_type,
          displayLabel: ref.display_label,
          path,
        },
        view: {
          title: view.title,
          caption: view.caption,
          source: view.source,
          evidence: view.evidence,
          coordinateDigestSha256: view.coordinates.sha256,
        },
      },
      nonce
    );

  let descriptor: unknown;
  try {
    descriptor = JSON.parse(ref.data);
  } catch {
    return null;
  }
  if (descriptor === null || typeof descriptor !== 'object') return null;

  const record = descriptor as Record<string, unknown>;
  if (
    (ref.entity_type === 'structure' || record.kind === 'structure') &&
    !hasCompleteStructureResidueIdentities(record)
  ) {
    return null;
  }
  stampDescriptorRefId(record, ref.id);

  let payload: string;
  try {
    payload = JSON.stringify(summarizeSequenceReference(record, ref.id));
  } catch {
    return null;
  }

  return serializePromptDataFence(
    'wp-sel',
    {
      reference: {
        refId: ref.id,
        entityType: ref.entity_type,
        displayLabel: ref.display_label,
        path,
        source: ref.source || 'unknown',
        measuredBy: 'app-computed',
      },
      descriptor: JSON.parse(payload),
    },
    nonce
  );
}

function stampDescriptorRefId(descriptor: Record<string, unknown>, refId: string): void {
  const locator = descriptor.locator;
  if (locator !== null && typeof locator === 'object') {
    (locator as Record<string, unknown>).refId = refId;
  } else {
    descriptor.locator = { refId };
  }
  const fetchField = descriptor.fetch;
  if (fetchField !== null && typeof fetchField === 'object') {
    const rawFallback = (fetchField as Record<string, unknown>).rawFallback;
    if (rawFallback !== null && typeof rawFallback === 'object') {
      (rawFallback as Record<string, unknown>).refId = refId;
    }
  }
}

function buildMeasuredSummary(measured: Record<string, unknown> | null): string {
  if (!measured) return '';
  if (
    typeof measured.structureRef === 'string' &&
    typeof measured.residueCount === 'number' &&
    Number.isFinite(measured.residueCount)
  ) {
    const regionCount =
      typeof measured.regionCount === 'number' && Number.isFinite(measured.regionCount)
        ? measured.regionCount
        : null;
    if (regionCount !== null) {
      const regionLabel = measured.disjoint === true ? 'disjoint regions' : 'regions';
      return `${measured.residueCount} residues across ${regionCount} ${regionLabel}`;
    }
    return `${measured.residueCount} residues`;
  }

  if (measured.disjoint === true && Array.isArray(measured.regions)) {
    return `${measured.regions.length} disjoint regions`;
  }
  const parts: string[] = [];
  const { length, start, end, strand, topology } = measured;
  if (typeof length === 'number' && Number.isFinite(length)) {
    parts.push(`${length} bp`);
  } else if (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start
  ) {
    parts.push(`${end - start + 1} bp`);
  }
  if (strand === '+' || strand === '-' || strand === 'unspecified') {
    parts.push(`strand ${strand}`);
  }
  if (topology === 'linear' || topology === 'circular') {
    parts.push(topology);
  }
  return parts.join(', ');
}

export function serializeSelectionHandle(ref: DBEntityReference): string | null {
  if (!ref.data) return null;

  let descriptor: unknown;
  try {
    descriptor = JSON.parse(ref.data);
  } catch {
    return null;
  }
  if (descriptor === null || typeof descriptor !== 'object') return null;
  const descriptorRecord = descriptor as Record<string, unknown>;
  if (
    (ref.entity_type === 'structure' || descriptorRecord.kind === 'structure') &&
    !hasCompleteStructureResidueIdentities(descriptorRecord)
  ) {
    return null;
  }

  const measuredRaw = descriptorRecord.measured;
  const summary = buildMeasuredSummary(
    measuredRaw !== null && typeof measuredRaw === 'object'
      ? (measuredRaw as Record<string, unknown>)
      : null
  );

  const refId = ref.id;
  const resource = `waypoint://selection/${refId}`;
  const summaryClause = summary ? `, ${summary}` : '';

  return (
    `Selection refId=${refId}, resource=${resource}${summaryClause}. ` +
    `Resolve it: read the resource (Claude Code) OR pass refId to the selection_* tools (both CLIs).`
  );
}

export function serializeReferenceCoords(
  entityType: string,
  deepLinkParams: Record<string, unknown> | null
): string {
  if (!deepLinkParams) return '';

  switch (entityType) {
    case 'sequence_region': {
      const { start, end, wraps } = deepLinkParams;
      if (typeof start !== 'number' || typeof end !== 'number') return '';
      const wrapNote = wraps === true ? ' (wraps origin)' : '';
      return `, region ${start}-${end}${wrapNote} (1-indexed inclusive)`;
    }
    case 'primer': {
      const { bindingStart, bindingEnd } = deepLinkParams;
      if (typeof bindingStart !== 'number' || typeof bindingEnd !== 'number') return '';
      return `, binding ${bindingStart}-${bindingEnd} (1-indexed inclusive)`;
    }
    case 'annotation': {
      const { start, end, featureName } = deepLinkParams;
      if (typeof start === 'number' && typeof end === 'number') {
        return `, region ${start}-${end}`;
      }
      if (typeof featureName === 'string' && featureName.length > 0) {
        return `, feature ${featureName}`;
      }
      return '';
    }
    case 'structure': {
      const groups = deepLinkParams.highlightGroups;
      if (!Array.isArray(groups) || groups.length === 0) return '';
      const parts: string[] = [];
      for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const group = g as Record<string, unknown>;
        if (!Array.isArray(group.selections)) continue;
        for (const rawSelection of group.selections) {
          if (!rawSelection || typeof rawSelection !== 'object') continue;
          const selection = rawSelection as Record<string, unknown>;
          if (typeof selection.chain !== 'string' || !Array.isArray(selection.ranges)) continue;
          const ranges = selection.ranges.flatMap((rawRange) => {
            if (!Array.isArray(rawRange) || rawRange.length !== 2) return [];
            const [start, end] = rawRange;
            if (
              typeof start !== 'number' ||
              typeof end !== 'number' ||
              !Number.isInteger(start) ||
              !Number.isInteger(end) ||
              start < 1 ||
              end < start
            ) {
              return [];
            }
            return [start === end ? String(start) : `${start}-${end}`];
          });
          if (ranges.length > 0) {
            const ligand =
              typeof selection.compId === 'string' ? ` ligand ${selection.compId}` : '';
            parts.push(`chain ${selection.chain}${ligand} residues ${ranges.join(', ')}`);
          }
        }
      }
      return parts.length > 0 ? `, ${parts.join('; ')} (auth_seq_id, 1-indexed inclusive)` : '';
    }
    default:
      return '';
  }
}

async function buildReferenceExpansion(
  ref: DBEntityReference,
  fenceNonce: string
): Promise<string> {
  const resolved = await resolveMolecularReferenceSnapshot(ref);
  if (resolved.document && resolved.view) {
    let descriptor: Record<string, unknown> | null =
      resolved.subject?.kind === 'selection' ? { ...resolved.subject.descriptor } : null;
    if (!descriptor && ref.data) {
      try {
        const candidate = JSON.parse(ref.data);
        if (hasCompleteStructureResidueIdentities(candidate)) descriptor = { ...candidate };
      } catch {}
    }
    if (!descriptor && ref.deep_link_params) {
      try {
        const candidate = JSON.parse(ref.deep_link_params).selectionDescriptor;
        if (hasCompleteStructureResidueIdentities(candidate)) descriptor = { ...candidate };
      } catch {}
    }
    if (descriptor) stampDescriptorRefId(descriptor, ref.id);
    return serializePromptDataFence(
      'wp-sel',
      {
        reference: {
          refId: ref.id,
          entityType: 'molecular-document',
          displayLabel: ref.display_label,
          path: ref.locator,
        },
        documentReference: resolved.document.documentReference,
        view: {
          title: resolved.view.title,
          caption: resolved.view.caption,
          source: resolved.view.source,
          evidence: resolved.view.evidence,
          coordinateDigestSha256: resolved.view.coordinates.sha256,
          snapshotIndex: resolved.snapshotIndex,
        },
        parameterAccess: {
          open: {
            tool: 'mol_open_tab',
            input: { documentReference: resolved.document.documentReference },
          },
          inspect: {
            tool: 'mol_get_scene',
            input: {
              documentReference: resolved.document.documentReference,
              includeParameterSchema: true,
            },
          },
          data: {
            tool: 'mol_data',
            input: { operation: 'inspect', documentReference: resolved.document.documentReference },
          },
        },
        datasets: resolved.view.molecularData?.datasets.map((dataset) => ({
          id: dataset.id,
          revision: dataset.revision,
          name: dataset.name,
          rowCount: dataset.records.length,
          columns: [...new Set(dataset.records.flatMap((row) => Object.keys(row)))],
        })),
        ...(descriptor ? { descriptor } : {}),
      },
      fenceNonce
    );
  }
  if (resolved.subject?.kind === 'visualization' && !resolved.subject.view)
    ref = { ...ref, data: resolved.reference.data };
  if (resolved.target && resolved.view) {
    const descriptor = resolved.subject?.kind === 'selection' ? resolved.subject.descriptor : null;
    if (descriptor) stampDescriptorRefId(descriptor, ref.id);
    return serializePromptDataFence(
      'wp-sel',
      {
        reference: {
          refId: ref.id,
          entityType: ref.entity_type,
          displayLabel: ref.display_label,
          path: ref.locator,
        },
        molecularTarget: resolved.target,
        view: {
          title: resolved.view.title,
          caption: resolved.view.caption,
          coordinateDigestSha256: resolved.view.coordinates.sha256,
          snapshotIndex: resolved.snapshotIndex,
        },
        ...(descriptor ? { descriptor } : {}),
      },
      fenceNonce
    );
  }

  let path = ref.locator;
  const gitMatch = path.match(/^git:\/\/[^/]+\/(.+)/);
  if (gitMatch) {
    path = gitMatch[1];
  }

  const descriptorFence = serializeReferenceDescriptorFence(ref, path, fenceNonce);
  if (descriptorFence) return descriptorFence;

  let deepLinkParams: Record<string, unknown> | null = null;
  if (ref.deep_link_params) {
    try {
      deepLinkParams = JSON.parse(ref.deep_link_params);
    } catch {}
  }
  const coordinateSummary = serializeReferenceCoords(ref.entity_type, deepLinkParams).replace(
    /^,\s*/,
    ''
  );
  return serializePromptDataFence(
    'wp-sel',
    {
      reference: {
        refId: ref.id,
        entityType: ref.entity_type,
        displayLabel: ref.display_label,
        path,
        source: ref.source || 'unknown',
      },
      coordinateSummary: coordinateSummary || null,
      descriptor: null,
    },
    fenceNonce
  );
}

export async function expandReferencesFromIds(
  content: string,
  referenceIds: string[]
): Promise<string> {
  if (referenceIds.length === 0) return content;
  const refs = await getEntityReferencesByIds(referenceIds);
  const refMap = new Map(refs.map((r) => [r.id, r]));

  const fenceNonce = nextSelectionFenceNonce();

  const expansions: string[] = [];
  for (const id of referenceIds) {
    const ref = refMap.get(id);
    if (!ref) continue;
    expansions.push(await buildReferenceExpansion(ref, fenceNonce));
  }
  if (expansions.length === 0) return content;
  const joined = expansions.join(' ');
  return content ? `${content}\n\n${joined}` : joined;
}

export async function containsIdentityCompleteStructureSelection(
  referenceIds: readonly string[]
): Promise<boolean> {
  if (referenceIds.length === 0) return false;
  const references = await getEntityReferencesByIds([...referenceIds]).catch(() => []);
  return references.some((reference) => {
    if (!reference.data) return false;
    try {
      return hasCompleteStructureResidueIdentities(JSON.parse(reference.data));
    } catch {
      return false;
    }
  });
}

export async function expandReferences(
  text: string,
  _workspacePath: string | null
): Promise<string> {
  let result = text;

  const matches = [...result.matchAll(new RegExp(REF_TOKEN_PATTERN, 'g'))];
  if (matches.length === 0) return result;

  const ids = matches.map((m) => m[1]);
  const refs = await getEntityReferencesByIds(ids);
  const refMap = new Map(refs.map((r) => [r.id, r]));

  const fenceNonce = nextSelectionFenceNonce();

  for (const match of matches) {
    const id = match[1];
    const ref = refMap.get(id);
    if (!ref) continue;

    result = result.split(match[0]).join(await buildReferenceExpansion(ref, fenceNonce));
  }

  return result;
}
