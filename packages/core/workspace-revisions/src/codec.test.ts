import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  MAX_CANONICAL_JSON_BYTES,
  MAX_CANONICAL_KEY_BYTES,
  MAX_CANONICAL_SCALAR_BYTES,
  parseStrictCanonicalJson,
  type CanonicalError,
} from './canonical-json';
import {
  classifyImmutableReplay,
  decodeCanonicalRecord,
  exportCanonicalClosure,
  importCanonicalRecords,
  type CanonicalGraphBundle,
  type OpaqueCanonicalRecord,
} from './codec-public';
import { validateDecodedClosure } from './codec';
import { hashCanonicalRecord } from './hash';
import { CANONICAL_RECORD_BYTE_LIMITS, canonicalRecordByteLength } from './record-budgets';
import {
  applyWorkspaceMutation,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  parseMemberId,
  parseOperationId,
  parseRefName,
  parseResourceRevisionId,
  parseResourceId,
  parseResourcePath,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from './index';

const MAIN_REF = must(parseRefName('main'));

interface CanonicalVector {
  readonly id: string;
  readonly value: unknown;
  readonly setLikeArrayPaths: readonly string[];
  readonly expected: string | null;
  readonly error: CanonicalError['kind'] | null;
}

function canonicalVectors(): readonly CanonicalVector[] {
  const decoded: unknown = JSON.parse(
    readFileSync(new URL('../fixtures/canonical-vectors.v1.json', import.meta.url), 'utf8')
  );
  if (!isRecord(decoded) || decoded.schemaVersion !== 1 || !Array.isArray(decoded.cases)) {
    throw new Error('Canonical vector fixture has an invalid envelope.');
  }
  return decoded.cases.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !('value' in candidate)) {
      throw new Error('Canonical vector fixture has an invalid case.');
    }
    const paths = candidate.setLikeArrayPaths;
    if (paths !== undefined && (!Array.isArray(paths) || !paths.every(isString))) {
      throw new Error(`Canonical vector ${candidate.id} has invalid set-like paths.`);
    }
    const expected = candidate.expected;
    const error = candidate.error;
    if (expected !== undefined && typeof expected !== 'string') {
      throw new Error(`Canonical vector ${candidate.id} has invalid expected bytes.`);
    }
    if (error !== undefined && !isCanonicalErrorKind(error)) {
      throw new Error(`Canonical vector ${candidate.id} has invalid error kind.`);
    }
    return {
      id: candidate.id,
      value: candidate.value,
      setLikeArrayPaths: paths ?? [],
      expected: expected ?? null,
      error: error ?? null,
    };
  });
}

describe('canonical JSON vectors', () => {
  it.each(canonicalVectors())('$id', ({ value, setLikeArrayPaths, expected, error }) => {
    const result = canonicalize(value, { setLikeArrayPaths });
    if (error === null) {
      expect(result).toEqual({ ok: true, value: expected });
    } else {
      expect(result).toEqual({ ok: false, error: { kind: error } });
    }
  });

  it.each([1.5, -0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-canonical number %s',
    (value) => {
      expect(canonicalize(value)).toEqual({ ok: false, error: { kind: 'invalid-number' } });
    }
  );

  it('rejects undefined, cycles, and non-plain objects', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(canonicalize(undefined)).toEqual({
      ok: false,
      error: { kind: 'unsupported-value' },
    });
    expect(canonicalize(cyclic)).toEqual({ ok: false, error: { kind: 'cycle' } });
    expect(canonicalize(new Date(0))).toEqual({
      ok: false,
      error: { kind: 'non-plain-object' },
    });
    expect(canonicalize('\ud800')).toEqual({
      ok: false,
      error: { kind: 'invalid-unicode' },
    });
    expect(canonicalize({ ['\ud800']: 'value' })).toEqual({
      ok: false,
      error: { kind: 'invalid-unicode' },
    });
  });

  it('requires strict canonical input bytes', () => {
    expect(parseStrictCanonicalJson('{"a":1,"b":2}')).toEqual({
      ok: true,
      value: '{"a":1,"b":2}',
    });
    expect(parseStrictCanonicalJson('{ "b": 2, "a": 1 }')).toEqual({
      ok: false,
      error: { kind: 'non-canonical-json' },
    });
    expect(parseStrictCanonicalJson('{broken')).toEqual({
      ok: false,
      error: { kind: 'invalid-json' },
    });
  });

  it('rejects oversized local and imported keys, scalars, and envelopes', () => {
    const oversizedKey = 'k'.repeat(MAX_CANONICAL_KEY_BYTES + 1);
    const oversizedScalar = 'v'.repeat(MAX_CANONICAL_SCALAR_BYTES + 1);
    expect(canonicalize({ [oversizedKey]: true })).toEqual({
      ok: false,
      error: { kind: 'key-budget-exceeded' },
    });
    expect(canonicalize(oversizedScalar)).toEqual({
      ok: false,
      error: { kind: 'scalar-budget-exceeded' },
    });
    expect(parseStrictCanonicalJson(JSON.stringify({ [oversizedKey]: true }))).toEqual({
      ok: false,
      error: { kind: 'key-budget-exceeded' },
    });
    expect(parseStrictCanonicalJson(JSON.stringify(oversizedScalar))).toEqual({
      ok: false,
      error: { kind: 'scalar-budget-exceeded' },
    });
    expect(parseStrictCanonicalJson(`"${'x'.repeat(MAX_CANONICAL_JSON_BYTES)}"`)).toEqual({
      ok: false,
      error: { kind: 'envelope-budget-exceeded' },
    });
  });
});

it('fails closed instead of overflowing on hostile canonical nesting depth', () => {
  const canonicalJson =
    '{"formatVersion":1,"payload":' + '['.repeat(5_000) + 'null' + ']'.repeat(5_000) + '}';
  expect(
    decodeCanonicalRecord({
      kind: 'resource-state',
      id: 'rs_hostile-depth',
      canonicalJson,
    })
  ).toEqual({
    ok: false,
    error: { kind: 'invalid-canonical-json', recordKind: 'resource-state' },
  });
});

describe('immutable record admission', () => {
  it('applies the byte ceiling for the claimed record kind before parsing or hashing', () => {
    const canonicalJson = must(
      canonicalize({
        formatVersion: 2,
        payload: Array.from({ length: 400 }, (_, index) => `${index}:${'x'.repeat(64)}`),
      })
    );
    expect(canonicalRecordByteLength(canonicalJson)).toBeGreaterThan(
      CANONICAL_RECORD_BYTE_LIMITS['workspace-version']
    );
    expect(canonicalRecordByteLength(canonicalJson)).toBeLessThan(
      CANONICAL_RECORD_BYTE_LIMITS['operation-receipt']
    );
    expect(
      decodeCanonicalRecord({ kind: 'workspace-version', id: 'wv_oversized', canonicalJson })
    ).toEqual({
      ok: false,
      error: { kind: 'record-too-large', recordKind: 'workspace-version' },
    });
    expect(
      decodeCanonicalRecord({ kind: 'operation-receipt', id: 'or_wrong-shape', canonicalJson })
    ).toMatchObject({
      ok: false,
      error: { kind: 'immutable-record-mismatch', recordKind: 'operation-receipt' },
    });
  });

  it('enforces the resource-state byte ceiling during local construction', () => {
    const result = defineResourceState({
      layout: 'file',
      resourceKind: 'oversized.metadata',
      mediaType: 'application/octet-stream',
      blob: defineBlob(new Uint8Array([1])),
      materialMetadata: {
        payload: Array.from({ length: 4_096 }, (_, index) => `${index}:${'x'.repeat(64)}`),
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid-material-metadata' },
    });
  });

  it('classifies equal identity and bytes as replay, but equal identity and different bytes as corruption', () => {
    const bundle = exampleBundle();
    const record = bundle.records[0];
    if (!record) throw new Error('Expected an exported record.');
    expect(classifyImmutableReplay(record, { ...record })).toEqual({ kind: 'replay' });
    expect(
      classifyImmutableReplay(record, { ...record, canonicalJson: `${record.canonicalJson} ` })
    ).toEqual({
      kind: 'corrupt',
      id: record.id,
    });

    const decoded = must(decodeCanonicalRecord(record));
    const changed = recanonicalize(record, { ...decoded.body, injected: true });
    expect(
      importCanonicalRecords({
        ...bundle,
        records: [...bundle.records, { ...changed, id: record.id }],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'immutable-record-corruption', id: record.id },
    });
  });

  it('refuses a recognized future format before interpreting current fields', () => {
    const state = findDecoded(exampleBundle(), 'resource-state');
    const future = recanonicalize(state.record, { formatVersion: 2 });
    expect(decodeCanonicalRecord(future)).toEqual({
      ok: false,
      error: { kind: 'unsupported-future-format', recordKind: 'resource-state', version: 2 },
    });
  });

  it('rejects an impossible unknown-resource mutation receipt', () => {
    const bundle = exampleBundle();
    const receipt = findDecoded(bundle, 'operation-receipt');
    const invalid = recanonicalize(receipt.record, {
      ...receipt.body,
      result: {
        outcome: 'rejected',
        error: { kind: 'unknown-resource', resourceId: 'resource-a' },
        recordWrites: [],
      },
    });

    expect(
      importCanonicalRecords({
        ...bundle,
        records: [...bundle.records.filter((record) => record.id !== receipt.record.id), invalid],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'invalid-record-body', recordKind: 'operation-receipt' },
    });
  });

  it('rejects a missing resource parent without returning a partial graph', () => {
    const bundle = exampleBundle();
    const revision = findDecoded(bundle, 'resource-revision', 'resource-a');
    const missingParent = hashCanonicalRecord(
      'resource-revision',
      must(canonicalize({ missing: true }))
    );
    const orphan = recanonicalize(revision.record, {
      ...revision.body,
      parentIds: [missingParent],
    });
    const result = importCanonicalRecords({
      ...bundle,
      records: [...bundle.records, orphan],
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'missing-resource-parent', revisionId: orphan.id, parentId: missingParent },
    });
    expect('value' in result).toBe(false);
  });

  it('rejects a missing workspace parent', () => {
    const bundle = exampleBundle();
    const version = findDecoded(bundle, 'workspace-version');
    const missingParent = hashCanonicalRecord(
      'workspace-version',
      must(canonicalize({ missing: true }))
    );
    const orphan = recanonicalize(version.record, {
      ...version.body,
      parentIds: [missingParent],
    });
    expect(importCanonicalRecords({ ...bundle, records: [...bundle.records, orphan] })).toEqual({
      ok: false,
      error: { kind: 'missing-workspace-parent', versionId: orphan.id, parentId: missingParent },
    });
  });

  it('rejects a cross-resource parent', () => {
    const bundle = exampleBundle();
    const first = findDecoded(bundle, 'resource-revision', 'resource-a');
    const second = findDecoded(bundle, 'resource-revision', 'resource-b');
    const invalid = recanonicalize(first.record, {
      ...first.body,
      parentIds: [second.record.id],
    });
    expect(importCanonicalRecords({ ...bundle, records: [...bundle.records, invalid] })).toEqual({
      ok: false,
      error: {
        kind: 'cross-resource-parent',
        revisionId: invalid.id,
        parentId: second.record.id,
      },
    });
  });

  it('rejects a second zero-parent root for one stable resource identity', () => {
    const bundle = siblingEditBundles().bundle;
    const revisions = bundle.records
      .filter((record) => record.kind === 'resource-revision')
      .map((record) => ({ record, decoded: must(decodeCanonicalRecord(record)) }))
      .filter(({ decoded }) => decoded.body.resourceId === 'resource-a');
    const first = revisions.find(
      ({ decoded }) => Array.isArray(decoded.body.parentIds) && decoded.body.parentIds.length === 0
    );
    const child = revisions.find(
      ({ decoded }) => Array.isArray(decoded.body.parentIds) && decoded.body.parentIds.length === 1
    );
    if (!first || !child) throw new Error('Expected root and child revision fixtures.');
    const duplicateRoot = recanonicalize(first.record, {
      ...first.decoded.body,
      stateHash: child.decoded.body.stateHash,
    });
    const result = importCanonicalRecords({
      ...bundle,
      records: [...bundle.records, duplicateRoot],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'duplicate-resource-root',
        resourceId: 'resource-a',
        revisionIds: [first.record.id, duplicateRoot.id].sort(),
      },
    });
  });

  it('rejects a one-parent workspace transition that swaps to a sibling revision', () => {
    const branches = siblingEditBundles();
    const forged = recanonicalize(branches.leftVersion.record, {
      ...branches.leftVersion.body,
      parentIds: [branches.rightVersion.record.id],
    });
    const result = importCanonicalRecords({
      ...branches.bundle,
      refs: [{ name: 'main', head: forged.id }],
      records: [...branches.bundle.records, forged],
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid-workspace-transition', versionId: forged.id },
    });
  });

  it('rejects a two-parent workspace version that is not the conservative recomposition', () => {
    const branches = siblingEditBundles();
    const forged = recanonicalize(branches.leftVersion.record, {
      ...branches.leftVersion.body,
      parentIds: [branches.leftVersion.record.id, branches.rightVersion.record.id].sort(),
    });
    const result = importCanonicalRecords({
      ...branches.bundle,
      refs: [{ name: 'main', head: forged.id }],
      records: [...branches.bundle.records, forged],
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid-workspace-merge', versionId: forged.id },
    });
  });

  it('detects a same-resource parent cycle in the closure validator', () => {
    const bundle = exampleBundle();
    const stateRecords = bundle.records
      .filter((record) => record.kind === 'resource-state')
      .map((record) => must(decodeCanonicalRecord(record)));
    const source = findDecoded(bundle, 'resource-revision', 'resource-a');
    const secondId = hashCanonicalRecord('resource-revision', must(canonicalize({ second: true })));
    const firstInCycle = {
      ...source,
      body: { ...source.body, parentIds: [secondId] },
    };
    const secondInCycle = {
      ...source,
      id: secondId,
      body: { ...source.body, parentIds: [source.record.id] },
    };
    expect(
      validateDecodedClosure({
        workspaceId: bundle.workspaceId,
        refs: [],
        records: [...stateRecords, firstInCycle, secondInCycle],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'resource-parent-cycle', revisionId: source.record.id },
    });
  });

  it('rejects an accepted ref that names an incomplete graph', () => {
    const bundle = exampleBundle();
    const missingHead = hashCanonicalRecord(
      'workspace-version',
      must(canonicalize({ missing: true }))
    );
    expect(
      importCanonicalRecords({
        ...bundle,
        refs: [{ name: 'main', head: missingHead }],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'incomplete-accepted-ref', refName: 'main', head: missingHead },
    });
  });

  it('stores a constant workspace header and opaque canonical map nodes', () => {
    const bundle = exampleBundle();
    const version = acceptedWorkspaceVersion(bundle);
    expect(version.body).not.toHaveProperty('resources');
    expect(version.body).toMatchObject({
      formatVersion: 2,
      resourceCount: 2,
    });
    expect(bundle.records.some((record) => record.kind === 'workspace-resource-map-node')).toBe(
      true
    );
    expect(bundle.records.some((record) => record.kind === 'workspace-path-map-node')).toBe(true);
    expect(importCanonicalRecords(bundle).ok).toBe(true);
  });

  it('rejects workspace headers whose counts disagree with their Merkle roots', () => {
    const bundle = exampleBundle();
    const version = acceptedWorkspaceVersion(bundle);
    if (
      typeof version.body.resourceCount !== 'number' ||
      typeof version.body.materializedPathCount !== 'number'
    ) {
      throw new Error('Expected workspace root counts.');
    }
    const mismatchedResourceCount = recanonicalize(version.record, {
      ...version.body,
      resourceCount: version.body.resourceCount + 1,
    });
    expect(
      importCanonicalRecords(
        replaceAcceptedVersion(bundle, version.record, mismatchedResourceCount)
      )
    ).toEqual({
      ok: false,
      error: { kind: 'invalid-record-body', recordKind: 'workspace-version' },
    });

    const mismatchedPathCount = recanonicalize(version.record, {
      ...version.body,
      materializedPathCount: version.body.materializedPathCount + 1,
    });
    expect(
      importCanonicalRecords(replaceAcceptedVersion(bundle, version.record, mismatchedPathCount))
    ).toEqual({
      ok: false,
      error: { kind: 'invalid-record-body', recordKind: 'workspace-version' },
    });
  });

  it('rejects joined-path overflow while rebuilding imported materialization', () => {
    const initial = createRevisionGraph({
      workspaceId: must(parseWorkspaceId('overflow-import-workspace')),
      acceptedRef: MAIN_REF,
    });
    const resourceId = must(parseResourceId('overflow-import-resource'));
    const memberPath = `${'m'.repeat(200)}/${'n'.repeat(200)}/${'o'.repeat(200)}/${'p'.repeat(200)}`;
    const state = must(
      defineResourceState({
        layout: 'directory',
        resourceKind: 'sequence-package',
        format: 'forge',
        members: [
          {
            memberId: must(parseMemberId('overflow-import-member')),
            relativePath: must(parseResourcePath(memberPath)),
            mediaType: 'application/octet-stream',
            blob: defineBlob(new Uint8Array([1])),
          },
        ],
      })
    );
    const created = applyWorkspaceMutation({
      graph: initial,
      refName: MAIN_REF,
      expectedHead: null,
      operationId: must(parseOperationId('overflow-import-create')),
      mutation: {
        kind: 'create-resource',
        resourceId,
        path: must(parseWorkspacePath('x')),
        state,
        origin: { kind: 'created' },
      },
    });
    if (created.kind !== 'changed') throw new Error('Expected overflow import fixture.');
    const bundle = exportCanonicalClosure(created.graph);
    const version = acceptedWorkspaceVersion(bundle);
    const revision = findDecoded(bundle, 'resource-revision', resourceId).record.id;
    const longRoot = `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}`;
    const resourceRoot = forgeWorkspaceResourceRoot({
      resourceId,
      revisionId: revision,
      path: longRoot,
    });
    const forgedVersion = recanonicalize(version.record, {
      ...version.body,
      resourceRoot: resourceRoot.id,
    });
    const forgedBundle = replaceAcceptedVersion(bundle, version.record, forgedVersion);
    expect(
      importCanonicalRecords({
        ...forgedBundle,
        records: [...forgedBundle.records, resourceRoot],
      })
    ).toEqual({
      ok: false,
      error: { kind: 'invalid-materialized-tree', versionId: forgedVersion.id },
    });
  });
});

function exampleBundle(): CanonicalGraphBundle {
  const graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('workspace-codec')),
    acceptedRef: MAIN_REF,
  });
  const state = must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'text.note',
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode('shared')),
    })
  );
  const first = applyWorkspaceMutation({
    graph,
    refName: MAIN_REF,
    expectedHead: null,
    operationId: must(parseOperationId('codec-create-a')),
    mutation: {
      kind: 'create-resource',
      resourceId: must(parseResourceId('resource-a')),
      path: must(parseWorkspacePath('a.txt')),
      state,
      origin: { kind: 'created' },
    },
  });
  if (first.kind !== 'changed') throw new Error('Expected codec fixture create A.');
  const second = applyWorkspaceMutation({
    graph: first.graph,
    refName: MAIN_REF,
    expectedHead: first.version.id,
    operationId: must(parseOperationId('codec-create-b')),
    mutation: {
      kind: 'create-resource',
      resourceId: must(parseResourceId('resource-b')),
      path: must(parseWorkspacePath('b.txt')),
      state,
      origin: { kind: 'created' },
    },
  });
  if (second.kind !== 'changed') throw new Error('Expected codec fixture create B.');
  return exportCanonicalClosure(second.graph);
}

function siblingEditBundles() {
  const initial = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('workspace-codec')),
    acceptedRef: MAIN_REF,
  });
  const shared = must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'text.note',
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode('shared')),
    })
  );
  const first = applyWorkspaceMutation({
    graph: initial,
    refName: MAIN_REF,
    expectedHead: null,
    operationId: must(parseOperationId('sibling-create-a')),
    mutation: {
      kind: 'create-resource',
      resourceId: must(parseResourceId('resource-a')),
      path: must(parseWorkspacePath('a.txt')),
      state: shared,
      origin: { kind: 'created' },
    },
  });
  if (first.kind !== 'changed') throw new Error('Expected sibling fixture resource A.');
  const base = applyWorkspaceMutation({
    graph: first.graph,
    refName: MAIN_REF,
    expectedHead: first.version.id,
    operationId: must(parseOperationId('sibling-create-b')),
    mutation: {
      kind: 'create-resource',
      resourceId: must(parseResourceId('resource-b')),
      path: must(parseWorkspacePath('b.txt')),
      state: shared,
      origin: { kind: 'created' },
    },
  });
  if (base.kind !== 'changed') throw new Error('Expected sibling fixture resource B.');
  const baseBundle = exportCanonicalClosure(base.graph);
  const revision = findDecoded(baseBundle, 'resource-revision', 'resource-a').record.id;
  const resourceId = must(parseResourceId('resource-a'));
  const expectedRevision = must(parseResourceRevisionId(revision));
  const expectedHead = base.version.id;
  const edit = (side: 'left' | 'right') => {
    const state = must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'text.note',
        mediaType: 'text/plain',
        blob: defineBlob(new TextEncoder().encode(side)),
      })
    );
    const result = applyWorkspaceMutation({
      graph: base.graph,
      refName: MAIN_REF,
      expectedHead,
      operationId: must(parseOperationId(`codec-sibling-${side}`)),
      mutation: { kind: 'edit-resource', resourceId, expectedRevision, state },
    });
    if (result.kind !== 'changed') throw new Error(`Expected ${side} sibling edit.`);
    return exportCanonicalClosure(result.graph);
  };
  const left = edit('left');
  const right = edit('right');
  const bundle: CanonicalGraphBundle = {
    ...baseBundle,
    refs: [{ name: 'main', head: acceptedWorkspaceVersion(left).record.id }],
    records: [...left.records, ...right.records],
  };
  return {
    bundle,
    leftVersion: acceptedWorkspaceVersion(left),
    rightVersion: acceptedWorkspaceVersion(right),
  };
}

describe('graph envelope text validation', () => {
  it.each(['\ud800', 'a'.repeat(257)])('rejects invalid ref name %j', (name) => {
    const bundle = exampleBundle();
    expect(importCanonicalRecords({ ...bundle, refs: [{ ...bundle.refs[0], name }] })).toEqual({
      ok: false,
      error: { kind: 'invalid-ref', refName: name },
    });
  });
});

function findDecoded(
  bundle: CanonicalGraphBundle,
  kind: OpaqueCanonicalRecord['kind'],
  resourceId?: string
) {
  for (const record of bundle.records) {
    if (record.kind !== kind) continue;
    const decoded = must(decodeCanonicalRecord(record));
    if (resourceId === undefined || decoded.body.resourceId === resourceId) {
      return { ...decoded, record };
    }
  }
  throw new Error(`Expected ${kind} record${resourceId ? ` for ${resourceId}` : ''}.`);
}

function acceptedWorkspaceVersion(bundle: CanonicalGraphBundle) {
  const head = bundle.refs.find((ref) => ref.name === 'main')?.head;
  if (head === null || head === undefined) throw new Error('Expected an accepted workspace head.');
  const record = bundle.records.find(
    (candidate) => candidate.kind === 'workspace-version' && candidate.id === head
  );
  if (!record) throw new Error('Expected the accepted workspace version record.');
  const decoded = must(decodeCanonicalRecord(record));
  return { ...decoded, record };
}

function replaceAcceptedVersion(
  bundle: CanonicalGraphBundle,
  prior: OpaqueCanonicalRecord,
  replacement: OpaqueCanonicalRecord
): CanonicalGraphBundle {
  return {
    ...bundle,
    refs: bundle.refs.map((ref) =>
      ref.head === prior.id ? { ...ref, head: replacement.id } : ref
    ),
    records: [
      ...bundle.records.filter(
        (record) => record.id !== prior.id && record.kind !== 'operation-receipt'
      ),
      replacement,
    ],
  };
}

function recanonicalize(
  record: OpaqueCanonicalRecord,
  body: Readonly<Record<string, unknown>>
): OpaqueCanonicalRecord {
  const canonicalJson = must(canonicalize(body));
  if (record.kind === 'workspace-resource-map-node' || record.kind === 'workspace-path-map-node') {
    throw new Error('Test helper does not recanonicalize opaque workspace index nodes.');
  }
  return {
    kind: record.kind,
    id: hashCanonicalRecord(record.kind, canonicalJson),
    canonicalJson,
  };
}

function forgeWorkspaceResourceRoot(input: {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly path: string;
}): OpaqueCanonicalRecord {
  const canonicalJson = must(
    canonicalize({
      formatVersion: 1,
      prefixHex: bytesToHex(utf8ToBytes(input.resourceId)),
      value: {
        resourceId: input.resourceId,
        revisionId: input.revisionId,
        path: input.path,
        lastPath: input.path,
        tombstone: false,
      },
      children: [],
    })
  );
  const digest = bytesToHex(
    sha256(
      concatBytes(
        utf8ToBytes('dnaforge:workspace-resource-map-node:v1\0'),
        utf8ToBytes(canonicalJson)
      )
    )
  );
  return {
    kind: 'workspace-resource-map-node',
    id: `wrn_${digest}`,
    canonicalJson,
  };
}

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isCanonicalErrorKind(value: unknown): value is CanonicalError['kind'] {
  return (
    value === 'invalid-number' ||
    value === 'unsupported-value' ||
    value === 'non-plain-object' ||
    value === 'cycle' ||
    value === 'duplicate-set-value' ||
    value === 'invalid-unicode' ||
    value === 'max-depth-exceeded' ||
    value === 'node-budget-exceeded' ||
    value === 'invalid-json' ||
    value === 'non-canonical-json'
  );
}
