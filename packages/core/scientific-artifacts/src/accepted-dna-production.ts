import {
  parseAcceptedDnaProductionSelection,
  type AcceptedDnaProductionSelection,
  type VerifiedAcceptedDnaProductionBinding,
} from '@waypoint/domain-services';
import {
  createScientificReaderFamily,
  validateScientificHistory,
  type ScientificGraphInput,
  type ScientificHistoryV1,
} from '@waypoint/scientific-objects';
import {
  defineBlob,
  inspectWorkspaceVersion,
  parseResourceId,
  parseWorkspaceVersionId,
  type BlobRef,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { nativeScientificHistoryReader } from './history';
import { scientificNativeCodecs } from './native-codecs';

export interface AcceptedDnaProductionWitness {
  readonly schema: 'dnaforge.accepted-dna-production-witness.v1';
  readonly owner: VerifiedAcceptedDnaProductionBinding['owner'];
  readonly selection: AcceptedDnaProductionSelection;
  readonly history: ScientificHistoryV1;
  readonly blobs: readonly {
    readonly blob: BlobRef;
    readonly body: { readonly encoding: 'base64'; readonly value: string };
  }[];
}
export interface VerifiedAcceptedDnaProduction {
  readonly binding: VerifiedAcceptedDnaProductionBinding;
  readonly representation: { readonly format: 'genbank-v1'; readonly text: string };
  readonly capturedAcceptedHead: WorkspaceVersionId;
}
const limit = 17 * 1024 * 1024;
const fail = (): never => {
  throw Error(
    'ACCEPTED_DNA_PRODUCTION_INVALID: A complete accepted native DNA design proof is required.'
  );
};
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return fail();
  return row;
};
export function inspectAcceptedDnaProductionSelection(
  input: Pick<ScientificGraphInput, 'graph' | 'head' | 'readBlob'> & {
    readonly owner: VerifiedAcceptedDnaProductionBinding['owner'];
    readonly selection: AcceptedDnaProductionSelection;
    readonly requiredAcceptedAncestor?: WorkspaceVersionId;
  }
): VerifiedAcceptedDnaProduction {
  const selection = parseAcceptedDnaProductionSelection(input.selection),
    owner = object(input.owner, ['projectId', 'workspaceScope', 'scientificWorkspaceId']);
  if (
    Object.values(owner).some(
      (value) => typeof value !== 'string' || !value || value.includes('\0')
    ) ||
    !input.head ||
    owner.scientificWorkspaceId !== selection.scientificWorkspaceId
  )
    return fail();
  const version = parseWorkspaceVersionId(selection.revision.workspaceVersionId),
    resource = parseResourceId(selection.revision.resourceId);
  if (!version.ok || !resource.ok) return fail();
  const pending = [input.head],
    seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const row = inspectWorkspaceVersion(input.graph, current);
    if (!row.ok) return fail();
    pending.push(...row.value.parentIds);
  }
  if (
    !seen.has(version.value) ||
    (input.requiredAcceptedAncestor && !seen.has(input.requiredAcceptedAncestor))
  )
    return fail();
  const readers = createScientificReaderFamily({ ...input, codecs: scientificNativeCodecs });
  const selected = readers.at(version.value).current(resource.value),
    current = readers.at(input.head).current(resource.value);
  if (
    !selected ||
    !current ||
    selected.revisionId !== selection.revision.resourceRevisionId ||
    current.revisionId !== selected.revisionId ||
    selected.document.kind !== 'sequence' ||
    selected.document.molecule !== 'DNA' ||
    selected.document.bases.length === 0 ||
    selected.representation?.format !== 'genbank-v1' ||
    current.representation?.format !== 'genbank-v1'
  )
    return fail();
  const selectedHash = defineBlob(
    new TextEncoder().encode(selected.representation.text)
  ).hash.replace(/^sha256:/, '');
  const currentHash = defineBlob(
    new TextEncoder().encode(current.representation.text)
  ).hash.replace(/^sha256:/, '');
  if (selectedHash !== selection.revision.contentSha256 || currentHash !== selectedHash)
    return fail();
  return {
    binding: {
      kind: 'accepted-dna-design',
      owner: input.owner,
      selection,
      document: {
        name: selected.document.name,
        molecule: 'DNA',
        length: selected.document.bases.length,
        topology: selected.document.topology,
        scientificSha256: selected.scientificHash,
      },
    },
    representation: { format: 'genbank-v1', text: selected.representation.text },
    capturedAcceptedHead: input.head,
  };
}
export function verifyAcceptedDnaProductionWitness(value: unknown): VerifiedAcceptedDnaProduction {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail();
  }
  if (new TextEncoder().encode(serialized!).byteLength > limit) return fail();
  const row = object(value, ['schema', 'owner', 'selection', 'history', 'blobs']);
  if (row.schema !== 'dnaforge.accepted-dna-production-witness.v1' || !Array.isArray(row.blobs))
    return fail();
  const history = row.history as ScientificHistoryV1;
  if (!history || !Array.isArray(history.blobs) || history.blobs.length !== row.blobs.length)
    return fail();
  const bodies = new Map<string, Uint8Array>();
  for (let index = 0; index < row.blobs.length; index++) {
    const item = object(row.blobs[index], ['blob', 'body']),
      ref = object(item.blob, ['hash', 'byteLength']),
      body = object(item.body, ['encoding', 'value']);
    const expected = history.blobs[index];
    if (
      !expected ||
      ref.hash !== expected.hash ||
      ref.byteLength !== expected.byteLength ||
      bodies.has(expected.hash) ||
      body.encoding !== 'base64' ||
      typeof body.value !== 'string' ||
      body.value.length > Math.ceil(limit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.value)
    )
      return fail();
    let bytes: Uint8Array;
    try {
      const binary = atob(body.value);
      if (btoa(binary) !== body.value) return fail();
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
      return fail();
    }
    const actual = defineBlob(bytes);
    if (actual.hash !== expected.hash || actual.byteLength !== expected.byteLength) return fail();
    bodies.set(expected.hash, bytes);
  }
  if (
    history.graph.workspaceId !==
    (row.owner as VerifiedAcceptedDnaProductionBinding['owner']).scientificWorkspaceId
  )
    return fail();
  const readBlob = (blob: BlobRef) => bodies.get(blob.hash) ?? null;
  const validated = validateScientificHistory(history, nativeScientificHistoryReader(readBlob));
  return inspectAcceptedDnaProductionSelection({
    ...validated,
    readBlob,
    owner: row.owner as VerifiedAcceptedDnaProductionBinding['owner'],
    selection: parseAcceptedDnaProductionSelection(row.selection),
  });
}
