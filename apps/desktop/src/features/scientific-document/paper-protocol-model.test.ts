// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  canonicalPaperProtocolReviewPayload,
  finalizePaperProtocolWorkflow,
  parsePaperProtocolWorkflow,
  reopenPaperProtocolWorkflow,
  sha256PaperProtocolPayload,
  validatePaperProtocolSourceHashes,
} from './paper-protocol-model';
import { parseScientificDocument, updateProtocolStep } from './model';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const PREVIEW_FINGERPRINT = `sha256:${'c'.repeat(64)}`;

function workflow(): Record<string, unknown> {
  return {
    schema: 'dnaforge.paper-protocol.v1',
    candidate: {
      candidateSetId: 'paper-set-1',
      candidateId: 'paper-candidate-1',
      ordinal: 1,
      label: 'Cell lysis',
      status: 'selected',
    },
    draft: { revision: 3, state: 'draft', reopenedFromAcceptedVersionId: null },
    sources: [
      {
        sourceId: 'source-pdf',
        kind: 'pdf',
        title: 'Paper PDF',
        mediaType: 'application/pdf',
        sha256: HASH_A,
        capturedAt: '2026-08-19T00:00:00.000Z',
        workspacePath: 'papers/source.pdf',
        pageCount: 2,
        extraction: {
          name: 'opendataloader-pdf',
          version: '2.5.1',
          mode: 'deterministic-local',
          configuration: 'xycut-cluster-safety-on-images-off',
        },
        originalUrl: 'https://publisher.example/article?id=7',
        canonicalUrl: 'https://cdn.example/article-7.pdf',
      },
      {
        sourceId: 'source-web',
        kind: 'captured_text',
        title: 'Publisher methods',
        mediaType: 'text/html',
        sha256: HASH_B,
        capturedAt: '2026-08-19T00:01:00.000Z',
        originalUrl: 'https://example.org/paper',
        canonicalUrl: 'https://example.org/paper',
        text: 'Grow cells overnight at 37 C.',
      },
    ],
    evidence: [
      {
        evidenceId: 'evidence-pdf',
        stepId: 'step-1',
        sourceId: 'source-pdf',
        sourceSha256: HASH_A,
        evidenceClass: 'direct',
        quote: 'Lyse cells.',
        locator: {
          kind: 'pdf_rects',
          page: 1,
          rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
        },
      },
      {
        evidenceId: 'evidence-web',
        stepId: 'step-2',
        sourceId: 'source-web',
        sourceSha256: HASH_B,
        evidenceClass: 'resolved_reference',
        quote: 'overnight at 37 C',
        locator: { kind: 'text_span', start: 11, end: 28 },
      },
    ],
    gaps: [
      {
        gapId: 'gap-1',
        stepId: 'step-2',
        missing: 'Supplementary Table S3 was not supplied.',
        attemptedResolution: ['Checked the captured paper text.'],
      },
    ],
    acceptedVersions: [],
  };
}

describe('paper protocol workflow model', () => {
  it('parses representation-neutral evidence tied to exact protocol steps and sources', () => {
    expect(parsePaperProtocolWorkflow(workflow(), ['step-1', 'step-2'])).toMatchObject({
      candidate: { candidateId: 'paper-candidate-1', status: 'selected' },
      draft: { revision: 3, state: 'draft' },
      sources: [
        {
          kind: 'pdf',
          extraction: {
            name: 'opendataloader-pdf',
            version: '2.5.1',
            mode: 'deterministic-local',
          },
        },
        { kind: 'captured_text' },
      ],
      evidence: [
        { evidenceId: 'evidence-pdf', locator: { kind: 'pdf_rects', page: 1 } },
        { evidenceId: 'evidence-web', locator: { kind: 'text_span', start: 11, end: 28 } },
      ],
      gaps: [{ gapId: 'gap-1', stepId: 'step-2' }],
    });
  });

  it.each([
    [
      'duplicate source IDs',
      (value: Record<string, unknown>) => {
        const sources = value.sources as Array<Record<string, unknown>>;
        value.sources = [...sources, { ...sources[0] }];
      },
      /source IDs must be unique/i,
    ],
    [
      'dangling step evidence',
      (value: Record<string, unknown>) => {
        (value.evidence as Array<Record<string, unknown>>)[0].stepId = 'missing-step';
      },
      /unknown protocol step/i,
    ],
    [
      'stale source identity',
      (value: Record<string, unknown>) => {
        (value.evidence as Array<Record<string, unknown>>)[0].sourceSha256 = HASH_B;
      },
      /does not match its source/i,
    ],
    [
      'wrong locator kind',
      (value: Record<string, unknown>) => {
        (value.evidence as Array<Record<string, unknown>>)[0].locator = {
          kind: 'text_span',
          start: 0,
          end: 4,
        };
      },
      /PDF source requires PDF rectangle evidence/i,
    ],
    [
      'text quote mismatch',
      (value: Record<string, unknown>) => {
        (value.evidence as Array<Record<string, unknown>>)[1].quote = 'not in the snapshot';
      },
      /quote does not match/i,
    ],
    [
      'out-of-range PDF page',
      (value: Record<string, unknown>) => {
        const evidence = (value.evidence as Array<Record<string, unknown>>)[0];
        (evidence.locator as Record<string, unknown>).page = 3;
      },
      /page exceeds/i,
    ],
    [
      'duplicate evidence IDs',
      (value: Record<string, unknown>) => {
        const evidence = value.evidence as Array<Record<string, unknown>>;
        value.evidence = [...evidence, { ...evidence[0] }];
      },
      /evidence IDs must be unique/i,
    ],
  ])('rejects %s', (_label, mutate, expected) => {
    const value = workflow();
    mutate(value);
    expect(() => parsePaperProtocolWorkflow(value, ['step-1', 'step-2'])).toThrow(expected);
  });

  it('rejects accepted history whose revision order is not append-only', () => {
    const value = workflow();
    value.acceptedVersions = [acceptedVersion(3, 'accepted-3'), acceptedVersion(2, 'accepted-2')];
    expect(() => parsePaperProtocolWorkflow(value, ['step-1', 'step-2'])).toThrow(
      /accepted revisions must increase/i
    );
  });

  it('produces a stable review payload independent of object insertion order', async () => {
    const left = canonicalPaperProtocolReviewPayload({
      title: 'Protocol',
      overview: { type: 'doc', content: [] },
      steps: [{ id: 'step-1', ordinal: 1 }],
      inputs: [],
      outputs: [],
      paperProtocol: workflow(),
    });
    const right = canonicalPaperProtocolReviewPayload({
      paperProtocol: workflow(),
      outputs: [],
      inputs: [],
      steps: [{ ordinal: 1, id: 'step-1' }],
      overview: { content: [], type: 'doc' },
      title: 'Protocol',
    });
    expect(left).toBe(right);
    await expect(sha256PaperProtocolPayload(JSON.parse(left))).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/
    );
  });

  it('verifies captured text hashes instead of trusting declared identity', async () => {
    const parsed = parsePaperProtocolWorkflow(workflow(), ['step-1', 'step-2']);
    await expect(validatePaperProtocolSourceHashes(parsed)).rejects.toThrow(
      /captured text hash does not match/i
    );
  });

  it('projects canonical PDF evidence into the review model without legacy duplicate fields', () => {
    const raw = protocolDocumentWithWorkflow();
    const parsed = parseScientificDocument(
      '/lab/Protocols/Cell lysis/.forge/protocol.json',
      JSON.stringify(raw)
    );
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    expect(parsed.paperProtocol).toMatchObject({
      candidate: { candidateId: 'paper-candidate-1' },
      draft: { revision: 3, state: 'draft' },
      sources: [
        expect.objectContaining({ canonicalUrl: 'https://cdn.example/article-7.pdf' }),
        expect.any(Object),
      ],
    });
    expect(parsed.pdfSources).toEqual([
      expect.objectContaining({
        sourceId: 'source-pdf',
        workspacePath: 'papers/source.pdf',
      }),
    ]);
    expect(parsed.steps[0].pdfAnchors).toEqual([
      expect.objectContaining({ anchorId: 'evidence-pdf', page: 1, quote: 'Lyse cells.' }),
    ]);
  });

  it('invalidates exact step evidence and advances the draft revision after a correction', () => {
    const parsed = parseScientificDocument(
      '/lab/Protocols/Cell lysis/.forge/protocol.json',
      JSON.stringify(protocolDocumentWithWorkflow())
    );
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    const edited = updateProtocolStep(parsed, 'step-1', { contentText: 'Lyse the cells gently.' });
    expect(edited.paperProtocol?.draft).toMatchObject({ revision: 4, state: 'draft' });
    expect(edited.paperProtocol?.evidence.map((entry) => entry.stepId)).toEqual(['step-2']);
    expect(edited.paperProtocol?.gaps).toContainEqual(
      expect.objectContaining({ stepId: 'step-1', missing: expect.stringMatching(/edited/i) })
    );
  });

  it('makes an explicitly finalized paper protocol immutable', () => {
    const raw = protocolDocumentWithWorkflow();
    const paperProtocol = raw.paperProtocol as Record<string, unknown>;
    paperProtocol.acceptedVersions = [acceptedVersion(3, 'accepted-3')];
    (paperProtocol.draft as Record<string, unknown>).state = 'finalized';
    const parsed = parseScientificDocument(
      '/lab/Protocols/Cell lysis/.forge/protocol.json',
      JSON.stringify(raw)
    );
    if (parsed.kind !== 'protocol') throw new Error('Expected protocol.');

    expect(parsed.mutable).toBe(false);
    expect(() => updateProtocolStep(parsed, 'step-1', { title: 'Changed' })).toThrow(
      /finalized protocol is immutable/i
    );
  });

  it('finalizes an exact draft once and replays the same acceptance without another version', async () => {
    const raw = protocolDocumentWithWorkflow();
    const first = await finalizePaperProtocolWorkflow(raw, {
      expectedRevision: 3,
      finalizedAt: '2026-08-19T02:00:00.000Z',
      idempotencyKey: 'accept-cell-lysis-v3',
      previewFingerprint: PREVIEW_FINGERPRINT,
    });
    expect(first.replayed).toBe(false);
    expect(first.acceptedVersion).toMatchObject({
      draftRevision: 3,
      finalizedBy: 'user',
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect((first.raw.paperProtocol as Record<string, unknown>).acceptedVersions).toHaveLength(1);

    const replay = await finalizePaperProtocolWorkflow(first.raw, {
      expectedRevision: 3,
      finalizedAt: '2026-08-19T02:01:00.000Z',
      idempotencyKey: 'accept-cell-lysis-v3',
      previewFingerprint: PREVIEW_FINGERPRINT,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.acceptedVersion).toEqual(first.acceptedVersion);
    expect((replay.raw.paperProtocol as Record<string, unknown>).acceptedVersions).toHaveLength(1);

    await expect(
      finalizePaperProtocolWorkflow(first.raw, {
        expectedRevision: 3,
        finalizedAt: '2026-08-19T02:02:00.000Z',
        idempotencyKey: 'different-acceptance-intent',
        previewFingerprint: PREVIEW_FINGERPRINT,
      })
    ).rejects.toThrow(/idempotency key was reused/i);
  });

  it('rejects stale finalization and makes reopening explicit and versioned', async () => {
    const raw = protocolDocumentWithWorkflow();
    await expect(
      finalizePaperProtocolWorkflow(raw, {
        expectedRevision: 2,
        finalizedAt: '2026-08-19T02:00:00.000Z',
        idempotencyKey: 'stale-v2',
        previewFingerprint: PREVIEW_FINGERPRINT,
      })
    ).rejects.toThrow(/draft revision changed/i);

    const finalized = await finalizePaperProtocolWorkflow(raw, {
      expectedRevision: 3,
      finalizedAt: '2026-08-19T02:00:00.000Z',
      idempotencyKey: 'accept-cell-lysis-v3',
      previewFingerprint: PREVIEW_FINGERPRINT,
    });
    const reopened = await reopenPaperProtocolWorkflow(finalized.raw, {
      acceptedVersionId: finalized.acceptedVersion.acceptedVersionId,
      idempotencyKey: 'reopen-cell-lysis-v3',
    });
    expect((reopened.raw.paperProtocol as Record<string, unknown>).draft).toEqual({
      revision: 4,
      state: 'draft',
      reopenedFromAcceptedVersionId: finalized.acceptedVersion.acceptedVersionId,
      reopenIdempotencyKeyHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    const replayed = await reopenPaperProtocolWorkflow(reopened.raw, {
      acceptedVersionId: finalized.acceptedVersion.acceptedVersionId,
      idempotencyKey: 'reopen-cell-lysis-v3',
    });
    expect(replayed).toMatchObject({ replayed: true, draftRevision: 4 });
  });

  it('refuses to finalize a candidate the user has not selected', async () => {
    const raw = protocolDocumentWithWorkflow();
    const paperProtocol = raw.paperProtocol as Record<string, unknown>;
    (paperProtocol.candidate as Record<string, unknown>).status = 'proposed';
    await expect(
      finalizePaperProtocolWorkflow(raw, {
        expectedRevision: 3,
        finalizedAt: '2026-08-19T02:00:00.000Z',
        idempotencyKey: 'reject-unselected-v3',
        previewFingerprint: PREVIEW_FINGERPRINT,
      })
    ).rejects.toThrow(/selected/i);
  });
});

function acceptedVersion(revision: number, id: string): Record<string, unknown> {
  return {
    acceptedVersionId: id,
    draftRevision: revision,
    contentHash: HASH_A,
    sourceHashes: [HASH_A, HASH_B],
    finalizedAt: '2026-08-19T01:00:00.000Z',
    finalizedBy: 'user',
    idempotencyKeyHash: HASH_B,
    previewFingerprint: PREVIEW_FINGERPRINT,
    payload: { title: 'Accepted protocol' },
  };
}

function protocolDocumentWithWorkflow(): Record<string, unknown> {
  return {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'protocol-paper-candidate-1',
    title: 'Cell lysis',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'step-1',
        sourceStepId: 'paper-step-1',
        ordinal: 1,
        title: 'Lyse cells',
        content: { type: 'doc', content: [] },
      },
      {
        id: 'step-2',
        sourceStepId: 'paper-step-2',
        ordinal: 2,
        title: 'Grow cells',
        content: { type: 'doc', content: [] },
      },
    ],
    inputs: [],
    outputs: [],
    version: {
      sourceVersionId: 'paper-draft-v3',
      pinnedVersionHash: HASH_A,
      immutable: true,
      importedAt: '2026-08-19T00:02:00.000Z',
    },
    provenance: { provider: 'paper', capturedAt: '2026-08-19T00:02:00.000Z' },
    paperProtocol: workflow(),
  };
}
