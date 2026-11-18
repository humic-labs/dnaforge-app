import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SequenceDataLayerCommands } from './sequence-data-layer-commands';
import {
  writeWorkspaceTextFileAtomicInMain,
  WorkspaceFilePublicationUncertainError,
} from './primer-artifact-files';
import {
  MAX_SEQUENCE_DATA_LAYER_CSV_BYTES,
  SEQUENCE_DATA_LAYER_DIRECTORY,
  type SequenceDataLayerCreateRequest,
  type SequenceDataLayerTargetSnapshot,
} from '../shared/sequence-data-layer';
import type { GenomicLayerOperationState } from '@waypoint/genome-data';
import { canonicalJson } from '../shared/canonical-json';

const sequenceFingerprint = `sha256:${'a'.repeat(64)}`;
const annotationFingerprint = `annotation-document-v1:sha256:${'b'.repeat(64)}`;
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-layer-'));
  folders.push(root);
  let target: SequenceDataLayerTargetSnapshot = {
    documentId: 'existing-sequence',
    sequenceFingerprint,
    annotationFingerprint,
    length: 100,
    annotations: [{ id: 'gene-a', start0: 10, end0: 20, qualifiers: { locus_tag: ['tag-a'] } }],
  };
  let revoked = false;
  const states: GenomicLayerOperationState[] = [];
  const publish = vi.fn((input, guard) =>
    writeWorkspaceTextFileAtomicInMain(input, { durable: true, beforePublish: guard })
  );
  const resolveTarget = vi.fn(async (id: string) => {
    if (id !== target.documentId) throw new Error('TARGET_MISSING');
    return structuredClone(target);
  });
  const assertWritable = vi.fn(async () => {
    if (revoked) throw new Error('PROJECT_READONLY');
  });
  const dependencies = {
    resolveProject: async (project: string) => {
      if (project !== root) throw new Error('PROJECT_NOT_FOUND');
      return root;
    },
    capture: () => () => {
      if (revoked) throw new Error('PROJECT_REVOKED');
    },
    assertWritable,
    resolveTarget,
    publish,
    onState: (state: GenomicLayerOperationState) => states.push(state),
    now: () => '2026-11-16T00:00:00.000Z',
  };
  const request: SequenceDataLayerCreateRequest = {
    operation: 'create',
    project: root,
    requestId: 'attach-fitness',
    targetDocumentId: target.documentId,
    expectedSequenceFingerprint: sequenceFingerprint,
    csv: { kind: 'text', text: 'start,end,fitness\n10,20,0\n30,31,-2\n' },
    mapping: {
      kind: 'positions',
      startColumn: 'start',
      endColumn: 'end',
      coordinateSystem: 'zero-based-half-open',
    },
    valueColumns: ['fitness'],
    label: 'Mutation fitness',
    unit: 'log2 fold change',
    unresolvedPolicy: 'reject',
    aggregation: 'none',
  };
  return {
    root,
    states,
    request,
    dependencies,
    publish,
    resolveTarget,
    assertWritable,
    commands: new SequenceDataLayerCommands(dependencies),
    setTarget: (next: SequenceDataLayerTargetSnapshot) => {
      target = next;
    },
    getTarget: () => target,
    revoke: () => {
      revoked = true;
    },
  };
}

describe('native sequence data layer commands', () => {
  it('publishes a replayable immutable dataset through native atomic storage and its operation reducer', async () => {
    const f = await fixture();
    const saved = await f.commands.run(f.request);
    expect(saved.status).toBe('published');
    if (saved.status !== 'published') throw new Error('Layer was not published');
    expect(saved.availability).toEqual({ status: 'current' });
    expect(saved.path).toContain(join(f.root, SEQUENCE_DATA_LAYER_DIRECTORY));
    expect(saved.document.dataset.samples[0].observations.map((row) => row.value)).toEqual([0, -2]);
    expect(saved.document.source.csv).toBe(f.request.csv.kind === 'text' ? f.request.csv.text : '');
    expect(saved.document.source.sha256).toBe(
      `sha256:${createHash('sha256').update(saved.document.source.csv).digest('hex')}`
    );
    expect(f.states.map((state) => state.kind)).toEqual([
      'preparing',
      'prepared',
      'publishing',
      'published',
    ]);
    expect(f.publish).toHaveBeenCalledTimes(1);
    const reopened = await new SequenceDataLayerCommands(f.dependencies).run({
      operation: 'inspect',
      project: f.root,
      id: saved.document.id,
    });
    expect(reopened).toMatchObject({
      status: 'published',
      revision: saved.revision,
      document: saved.document,
    });
  });

  it('reattaches exact retries across owner restart and refuses request identity reuse with changed input', async () => {
    const f = await fixture();
    const first = await f.commands.run(f.request);
    const reopenedOwner = new SequenceDataLayerCommands(f.dependencies);
    expect(await reopenedOwner.run(f.request)).toMatchObject({ ...first, alreadyPublished: true });
    await expect(
      reopenedOwner.run({ ...f.request, label: 'Different interpretation' })
    ).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      message: expect.stringMatching(/conflict/iu),
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent identical commands without a second write', async () => {
    const f = await fixture();
    const results = await Promise.all([f.commands.run(f.request), f.commands.run(f.request)]);
    expect(results[0]).toEqual(results[1]);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it('returns needs-input without writing for unresolved annotation rows under reject policy', async () => {
    const f = await fixture();
    const request: SequenceDataLayerCreateRequest = {
      ...f.request,
      expectedAnnotationFingerprint: annotationFingerprint,
      csv: { kind: 'text', text: 'gene,fitness\ntag-a,1\nmissing,4\n' },
      mapping: { kind: 'annotation', identifierColumn: 'gene', identifierField: 'locus_tag' },
    };
    const result = await f.commands.run(request);
    expect(result).toMatchObject({
      status: 'needs-input',
      prepared: { publishable: false, report: { counts: { mapped: 1, unmapped: 1 } } },
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.states.map((state) => state.kind)).toEqual(['preparing', 'needs-input']);
    expect(await f.commands.run({ operation: 'list', project: f.root })).toEqual({
      status: 'listed',
      layers: [],
      errors: [],
    });
  });

  it('publishes explicit exclusion and preserves unresolved row outcomes', async () => {
    const f = await fixture();
    const saved = await f.commands.run({
      ...f.request,
      expectedAnnotationFingerprint: annotationFingerprint,
      csv: { kind: 'text', text: 'gene,fitness\ntag-a,1\nmissing,4\n' },
      mapping: { kind: 'annotation', identifierColumn: 'gene', identifierField: 'locus_tag' },
      unresolvedPolicy: 'exclude',
    });
    expect(saved).toMatchObject({
      status: 'published',
      document: { report: { counts: { mapped: 1, unmapped: 1 } } },
    });
  });

  it('rejects a changed target before any publication', async () => {
    const f = await fixture();
    let reads = 0;
    f.resolveTarget.mockImplementation(async () => ({
      ...f.getTarget(),
      ...(reads++ > 0 ? { sequenceFingerprint: `sha256:${'c'.repeat(64)}` } : {}),
    }));
    await expect(f.commands.run(f.request)).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      message: expect.stringContaining('target changed while preparing'),
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.kind).toBe('interrupted');
  });

  it('derives stale availability on reopening without rewriting historical mappings', async () => {
    const f = await fixture();
    const saved = await f.commands.run(f.request);
    if (saved.status !== 'published') throw new Error('Layer was not published');
    f.setTarget({ ...f.getTarget(), sequenceFingerprint: `sha256:${'c'.repeat(64)}` });
    const reopened = await f.commands.run({
      operation: 'inspect',
      project: f.root,
      id: saved.document.id,
    });
    expect(reopened).toMatchObject({
      status: 'published',
      revision: saved.revision,
      availability: { status: 'stale', reason: 'sequence-changed' },
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps already-published bindings inspectable when the target becomes unavailable', async () => {
    const f = await fixture();
    const saved = await f.commands.run(f.request);
    if (saved.status !== 'published') throw new Error('Layer was not published');
    f.resolveTarget.mockRejectedValue(new Error('TARGET_MISSING'));
    expect(
      await f.commands.run({ operation: 'inspect', project: f.root, id: saved.document.id })
    ).toMatchObject({
      status: 'published',
      availability: { status: 'unavailable', reason: 'TARGET_MISSING' },
    });
  });

  it('fences revoked authority at the actual atomic publication boundary', async () => {
    const f = await fixture();
    f.publish.mockImplementationOnce(async (input, guard) => {
      f.revoke();
      return writeWorkspaceTextFileAtomicInMain(input, { durable: true, beforePublish: guard });
    });
    await expect(f.commands.run(f.request)).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      message: expect.stringContaining('PROJECT_REVOKED'),
    });
    expect(await readdir(join(f.root, SEQUENCE_DATA_LAYER_DIRECTORY))).toEqual([]);
    expect(f.states.at(-1)?.kind).toBe('prepared');
  });

  it('recovers a successful publication whose acknowledgment was lost without another write', async () => {
    const f = await fixture();
    f.publish.mockImplementationOnce(async (input, guard) => {
      await writeWorkspaceTextFileAtomicInMain(input, { durable: true, beforePublish: guard });
      throw new WorkspaceFilePublicationUncertainError('Directory acknowledgment lost');
    });
    const saved = await f.commands.run(f.request);
    expect(saved).toMatchObject({
      status: 'published',
      warning: expect.stringContaining('reconciliation'),
    });
    expect(f.states.map((state) => state.kind)).toEqual([
      'preparing',
      'prepared',
      'publishing',
      'publication-uncertain',
      'published',
    ]);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it('settles publication even if the caller cancels after the writer has committed', async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.publish.mockImplementationOnce(async (input, guard) => {
      const result = await writeWorkspaceTextFileAtomicInMain(input, {
        durable: true,
        beforePublish: guard,
      });
      abort.abort();
      return result;
    });
    expect(await f.commands.run(f.request, { signal: abort.signal })).toMatchObject({
      status: 'published',
    });
    expect(f.states.at(-1)?.kind).toBe('published');
  });

  it('cancels before publication without creating an artifact', async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.commands.run(f.request, { signal: abort.signal })).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      message: expect.stringContaining('cancelled before publication'),
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.kind).toBe('cancelled');
  });

  it('inspects target fingerprints and available identifier fields through the native owner', async () => {
    const f = await fixture();
    expect(
      await f.commands.run({
        operation: 'target',
        project: f.root,
        targetDocumentId: 'existing-sequence',
      })
    ).toMatchObject({
      status: 'target',
      target: { sequenceFingerprint, annotationFingerprint, length: 100 },
      annotationIdentifiers: [
        { field: 'id', count: 1, distinct: 1 },
        { field: 'locus_tag', count: 1, distinct: 1 },
        { field: 'ID', count: 0, distinct: 0 },
      ],
    });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('imports a bounded project-relative CSV and retains its exact UTF-8 bytes including BOM', async () => {
    const f = await fixture();
    const csv = '\ufeffstart,end,fitness\r\n10,20,0\r\n';
    await writeFile(join(f.root, 'fitness.csv'), csv);
    const result = await f.commands.run({
      ...f.request,
      csv: { kind: 'path', path: 'fitness.csv' },
    });
    expect(result).toMatchObject({ status: 'published', document: { source: { csv } } });
  });

  it('refuses path escape, symlink escape and oversized CSV before a layer write', async () => {
    const f = await fixture();
    await expect(
      f.commands.run({ ...f.request, csv: { kind: 'path', path: '../outside.csv' } })
    ).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      message: expect.stringMatching(/inside/iu),
    });
    const outside = await mkdtemp(join(tmpdir(), 'dnaforge-layer-outside-'));
    folders.push(outside);
    await writeFile(join(outside, 'outside.csv'), 'start,end,fitness\n1,2,1\n');
    await symlink(join(outside, 'outside.csv'), join(f.root, 'link.csv'));
    await expect(
      f.commands.run({ ...f.request, csv: { kind: 'path', path: 'link.csv' } })
    ).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      message: expect.stringMatching(/inside|symbolic/iu),
    });
    await expect(
      f.commands.run({
        ...f.request,
        csv: { kind: 'text', text: 'x'.repeat(MAX_SEQUENCE_DATA_LAYER_CSV_BYTES + 1) },
      })
    ).resolves.toMatchObject({ status: 'failed', disposition: 'not-published' });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('rejects a tampered retained dataset on read instead of trusting renderer-ready data', async () => {
    const f = await fixture();
    const saved = await f.commands.run(f.request);
    if (saved.status !== 'published') throw new Error('Layer was not published');
    const document = JSON.parse(await readFile(saved.path, 'utf8'));
    document.dataset.samples[0].observations[0].value = 17;
    await writeFile(saved.path, JSON.stringify(document));
    await expect(
      f.commands.run({ operation: 'inspect', project: f.root, id: saved.document.id })
    ).rejects.toThrow('does not match');
  });

  it('pins unresolved policy in the prepared mapping fingerprint', async () => {
    const f = await fixture();
    await f.commands.run(f.request);
    const state = f.states[0];
    if (state.kind !== 'preparing') throw new Error('The operation did not start');
    const mapping = canonicalJson({
      mapping: f.request.mapping,
      valueColumns: f.request.valueColumns,
      aggregation: f.request.aggregation,
      unresolvedPolicy: f.request.unresolvedPolicy,
    });
    expect(state.attempt.inputs.mappingSpecFingerprint).toBe(
      `sha256:${createHash('sha256').update(mapping).digest('hex')}`
    );
  });

  it('rejects a changed retained creation request ID even when the input hash is unchanged', async () => {
    const f = await fixture();
    const saved = await f.commands.run(f.request);
    if (saved.status !== 'published') throw new Error('Layer was not published');
    const document = JSON.parse(await readFile(saved.path, 'utf8'));
    document.creationRequest.id = 'forged-request';
    await writeFile(saved.path, JSON.stringify(document));
    await expect(
      f.commands.run({ operation: 'inspect', project: f.root, id: saved.document.id })
    ).rejects.toThrow('identity');
  });

  it('rejects a copied artifact whose command identity belongs to another project root', async () => {
    const f = await fixture();
    const other = await fixture();
    const saved = await f.commands.run(f.request);
    if (saved.status !== 'published') throw new Error('Layer was not published');
    const directory = join(other.root, SEQUENCE_DATA_LAYER_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${saved.document.id}.dnalayer.json`),
      await readFile(saved.path)
    );
    await expect(
      other.commands.run({ operation: 'inspect', project: other.root, id: saved.document.id })
    ).rejects.toThrow('identity');
  });

  it('returns an explicit not-published result for malformed CSV and old expected target pins', async () => {
    const f = await fixture();
    await expect(
      f.commands.run({
        ...f.request,
        csv: { kind: 'text', text: 'start,end,fitness\n"unterminated' },
      })
    ).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      requestId: f.request.requestId,
    });
    await expect(
      f.commands.run({ ...f.request, expectedSequenceFingerprint: `sha256:${'f'.repeat(64)}` })
    ).resolves.toMatchObject({
      status: 'failed',
      disposition: 'not-published',
      requestId: f.request.requestId,
    });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('keeps a failed native readback explicitly uncertain after the writer was invoked', async () => {
    const f = await fixture();
    f.publish.mockImplementationOnce(async (input, guard) => {
      await writeWorkspaceTextFileAtomicInMain(input, { durable: true, beforePublish: guard });
      await writeFile(input.path, '{');
      throw new WorkspaceFilePublicationUncertainError('Publication acknowledgment lost');
    });
    const result = await f.commands.run(f.request);
    expect(result).toMatchObject({
      status: 'failed',
      disposition: 'publication-uncertain',
      requestId: f.request.requestId,
      id: expect.stringMatching(/^layer-[a-f0-9]{64}$/u),
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)?.kind).toBe('publication-uncertain');
  });

  it('does not treat current path absence as proof that an uncertain writer never committed', async () => {
    const f = await fixture();
    f.publish.mockRejectedValueOnce(
      new WorkspaceFilePublicationUncertainError('Commit outcome unavailable')
    );
    expect(await f.commands.run(f.request)).toMatchObject({
      status: 'failed',
      disposition: 'publication-uncertain',
      requestId: f.request.requestId,
    });
    expect(f.states.at(-1)?.kind).toBe('publication-uncertain');
  });
});

describe('reusing a retained dataset on another sequence', () => {
  async function sourceAndTarget() {
    const source = await fixture();
    const sourceRequest = {
      ...source.request,
      expectedAnnotationFingerprint: annotationFingerprint,
      csv: { kind: 'text' as const, text: 'tag,fitness\ntag-a,0\n' },
      mapping: {
        kind: 'annotation' as const,
        identifierColumn: 'tag',
        identifierField: 'locus_tag' as const,
      },
    };
    const saved = await source.commands.run(sourceRequest);
    if (saved.status !== 'published') throw new Error('Source fixture was not published.');
    const target = await fixture();
    target.setTarget({
      ...target.getTarget(),
      documentId: 'another-sequence',
      sequenceFingerprint: `sha256:${'c'.repeat(64)}`,
      annotations: [{ id: 'gene-b', start0: 70, end0: 90, qualifiers: { locus_tag: ['tag-a'] } }],
    });
    let sourceRevoked = false;
    const dependencies = {
      ...target.dependencies,
      resolveProject: async (project: string) => {
        if (project !== source.root && project !== target.root)
          throw new Error('PROJECT_NOT_FOUND');
        return project;
      },
      capture: (root: string) =>
        root === source.root
          ? () => {
              if (sourceRevoked) throw new Error('SOURCE_PROJECT_REVOKED');
            }
          : target.dependencies.capture(),
    };
    const request = {
      ...sourceRequest,
      project: target.root,
      requestId: 'bind-existing-dataset',
      targetDocumentId: target.getTarget().documentId,
      expectedSequenceFingerprint: target.getTarget().sequenceFingerprint,
      csv: {
        kind: 'layer' as const,
        source: { project: source.root, id: saved.document.id, revision: saved.revision },
      },
    };
    return {
      source,
      target,
      saved,
      request,
      dependencies,
      commands: new SequenceDataLayerCommands(dependencies),
      revokeSource: () => {
        sourceRevoked = true;
      },
    };
  }

  it('maps the same immutable measurements independently of the original target availability', async () => {
    const f = await sourceAndTarget();
    f.source.setTarget({ ...f.source.getTarget(), documentId: 'original-sequence-removed' });
    const rebound = await f.commands.run(f.request);
    expect(rebound.status).toBe('published');
    if (rebound.status !== 'published') throw new Error(JSON.stringify(rebound));
    expect(rebound.document.target.documentId).toBe('another-sequence');
    expect(rebound.document.dataset.samples[0].observations).toMatchObject([
      { value: 0, start: 70, end: 90 },
    ]);
    expect(rebound.document.source).toEqual({
      ...f.saved.document.source,
      origin: f.request.csv.source,
    });
    expect(f.target.resolveTarget.mock.calls.every(([id]) => id === 'another-sequence')).toBe(true);
  });

  it('refuses a different retained source revision before publishing', async () => {
    const f = await sourceAndTarget();
    const result = await f.commands.run({
      ...f.request,
      csv: { ...f.request.csv, source: { ...f.request.csv.source, revision: 'd'.repeat(64) } },
    });
    expect(result).toMatchObject({ status: 'failed', disposition: 'not-published' });
    expect(f.target.publish).not.toHaveBeenCalled();
  });

  it('reconciles an unchanged retry from the saved binding after the source file is removed', async () => {
    const f = await sourceAndTarget();
    const first = await f.commands.run(f.request);
    if (first.status !== 'published') throw new Error(JSON.stringify(first));
    await rm(f.saved.path);
    const replayed = await new SequenceDataLayerCommands(f.dependencies).run(f.request);
    expect(replayed).toMatchObject({
      status: 'published',
      alreadyPublished: true,
      revision: first.revision,
    });
    expect(f.target.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses publication if source project access is revoked during target resolution', async () => {
    const f = await sourceAndTarget();
    f.target.resolveTarget.mockImplementation(async () => {
      f.revokeSource();
      return f.target.getTarget();
    });
    const result = await f.commands.run(f.request);
    expect(result).toMatchObject({ status: 'failed', disposition: 'not-published' });
    expect(f.target.publish).not.toHaveBeenCalled();
  });

  it.each([{ unit: 'counts' }, { valueColumns: ['start'] }])(
    'does not relabel source units or invent a measurement column: %j',
    async (patch) => {
      const f = await sourceAndTarget();
      const result = await f.commands.run({ ...f.request, ...patch });
      expect(result).toMatchObject({ status: 'failed', disposition: 'not-published' });
      expect(f.target.publish).not.toHaveBeenCalled();
    }
  );
});
