// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { parseScientificDocument } from '../scientific-document/model';
import {
  anchorsForStep,
  protocolForPdf,
  registrationFromProtocol,
  usePaperProtocolReviewStore,
} from './store';

const protocolPath = '/workspace/protocols/source.dnaforge-protocol.json';
const pdfPath = '/workspace/papers/source.pdf';

beforeEach(() => {
  usePaperProtocolReviewStore.setState({
    protocols: {},
    pdfs: {},
    selectedStep: null,
    hoveredStep: null,
  });
});

describe('paper protocol review state', () => {
  it('links a portable protocol source to exact local PDF identity and page geometry', () => {
    const document = parseScientificDocument(protocolPath, protocolJson());
    if (document.kind !== 'protocol') throw new Error('Expected protocol.');
    const registration = registrationFromProtocol(protocolPath, document, (path) =>
      path === 'papers/source.pdf' ? pdfPath : null
    );
    expect(registration).not.toBeNull();
    usePaperProtocolReviewStore.getState().registerProtocol(registration!);

    const linked = protocolForPdf(usePaperProtocolReviewStore.getState().protocols, pdfPath);
    expect(linked?.sources[0]).toMatchObject({
      absolutePath: pdfPath,
      sha256: 'c'.repeat(64),
    });
    expect(linked).toMatchObject({
      candidate: { candidateId: 'paper-candidate-1', status: 'selected' },
      draftRevision: 2,
      gapCount: 0,
      sourceKinds: ['pdf'],
    });
    expect(anchorsForStep(linked, { protocolPath, stepId: 'step-1' }, pdfPath)).toEqual([
      expect.objectContaining({
        page: 1,
        quote: 'Cells were lysed in 20 mM Tris at 4 C and centrifuged for 30 min.',
      }),
    ]);
  });

  it('does not project anchors onto an unrelated PDF', () => {
    const document = parseScientificDocument(protocolPath, protocolJson());
    if (document.kind !== 'protocol') throw new Error('Expected protocol.');
    const registration = registrationFromProtocol(protocolPath, document, () => pdfPath);
    if (!registration) throw new Error('Expected registration.');
    expect(
      anchorsForStep(
        registration,
        { protocolPath, stepId: 'step-1' },
        '/workspace/papers/other.pdf'
      )
    ).toEqual([]);
  });
});

function protocolJson(): string {
  return JSON.stringify({
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'protocol-1',
    title: 'Source protocol',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'step-1',
        ordinal: 1,
        title: 'Lyse cells',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lyse cells.' }] }],
        },
        sourceStatus: 'source',
        sourceSpans: [],
        pdfAnchors: [
          {
            anchorId: 'anchor-1',
            sourceId: 'paper-main',
            page: 1,
            quote: 'Cells were lysed in 20 mM Tris at 4 C and centrifuged for 30 min.',
            rects: [{ x: 0.11, y: 0.2, width: 0.68, height: 0.03 }],
          },
        ],
        puntId: null,
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: `sha256:${'c'.repeat(64)}`,
      pinnedVersionHash: `sha256:${'c'.repeat(64)}`,
      immutable: true,
      importedAt: '2026-08-19T00:00:00.000Z',
    },
    provenance: { provider: 'local-pdf', capturedAt: '2026-08-19T00:00:00.000Z' },
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: 'paper-set-1',
        candidateId: 'paper-candidate-1',
        ordinal: 1,
        label: 'Source protocol',
        status: 'selected',
      },
      draft: { revision: 2, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: 'paper-main',
          kind: 'pdf',
          title: 'Source paper',
          mediaType: 'application/pdf',
          workspacePath: 'papers/source.pdf',
          sha256: `sha256:${'c'.repeat(64)}`,
          capturedAt: '2026-08-19T00:00:00.000Z',
          pageCount: 2,
        },
      ],
      evidence: [
        {
          evidenceId: 'anchor-1',
          stepId: 'step-1',
          sourceId: 'paper-main',
          sourceSha256: `sha256:${'c'.repeat(64)}`,
          evidenceClass: 'direct',
          quote: 'Cells were lysed in 20 mM Tris at 4 C and centrifuged for 30 min.',
          locator: {
            kind: 'pdf_rects',
            page: 1,
            rects: [{ x: 0.11, y: 0.2, width: 0.68, height: 0.03 }],
          },
        },
      ],
      gaps: [],
      acceptedVersions: [],
    },
  });
}
