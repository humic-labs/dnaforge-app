import type { AppScenario } from './types';

const PAPER_PROTOCOL_PDF_BASE64 =
  'JVBERi0xLjQKJSBkZXRlcm1pbmlzdGljIEROQUZvcmdlIGZpeHR1cmUKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA0IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNyAwIFIgPj4KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9MZW5ndGggNjM3ID4+CnN0cmVhbQpCVAovRjEgMTggVGYKMSAwIDAgMSA3MiA3MjAgVG0KKEROQUZvcmdlIFBhcGVyLXRvLVByb3RvY29sIEZpeHR1cmUpIFRqCi9GMSAxMSBUZgoxIDAgMCAxIDcyIDY5NiBUbQooQSBkZXRlcm1pbmlzdGljIHN5bnRoZXRpYyBtZXRob2RzIHBhcGVyIGZvciBiZWhhdmlvcmFsIHRlc3RzLikgVGoKL0YxIDE1IFRmCjEgMCAwIDEgNzIgNjUwIFRtCihQcm90ZWluIFB1cmlmaWNhdGlvbikgVGoKL0YxIDEyIFRmCjEgMCAwIDEgNzIgNjIwIFRtCihDZWxscyB3ZXJlIGx5c2VkIGluIDIwIG1NIFRyaXMgYXQgNCBDIGFuZCBjZW50cmlmdWdlZCBmb3IgMzAgbWluLikgVGoKL0YxIDEyIFRmCjEgMCAwIDEgNzIgNTk4IFRtCihUaGUgY2xlYXJlZCBseXNhdGUgd2FzIHJldGFpbmVkIG9uIGljZS4pIFRqCi9GMSAxNSBUZgoxIDAgMCAxIDcyIDU0MCBUbQooTGlicmFyeSBDb25zdHJ1Y3Rpb24pIFRqCi9GMSAxMiBUZgoxIDAgMCAxIDcyIDUxMCBUbQooUHJpbWVyIHNlcXVlbmNlcyBhcmUgbGlzdGVkIGluIFN1cHBsZW1lbnRhcnkgVGFibGUgUzMuKSBUagovRjEgMTIgVGYKMSAwIDAgMSA3MiA0ODggVG0KKFRoZSBQQ1IgY3ljbGluZyBwcm9ncmFtIHdhcyBwZXJmb3JtZWQgYXMgZGVzY3JpYmVkIGluIHJlZmVyZW5jZSAyMy4pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNyAwIG9iago8PCAvTGVuZ3RoIDIwMSA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjEgMCAwIDEgNzIgNzIwIFRtCihTdXBwbGVtZW50YXJ5IFRhYmxlIFMzKSBUagovRjEgMTIgVGYKMSAwIDAgMSA3MiA2ODAgVG0KKFByaW1lciBwRXhhbXBsZV9GIHdhcyB1c2VkIGF0IDEwIHVNLikgVGoKL0YxIDEyIFRmCjEgMCAwIDEgNzIgNjU4IFRtCihQcmltZXIgcEV4YW1wbGVfUiB3YXMgdXNlZCBhdCAxMCB1TS4pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDQyIDAwMDAwIG4gCjAwMDAwMDAwOTEgMDAwMDAgbiAKMDAwMDAwMDE1NCAwMDAwMCBuIAowMDAwMDAwMjgwIDAwMDAwIG4gCjAwMDAwMDA0MDYgMDAwMDAgbiAKMDAwMDAwMDQ3NiAwMDAwMCBuIAowMDAwMDAxMTY0IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMTQxNgolJUVPRgo=';
const PAPER_PROTOCOL_PDF = atob(PAPER_PROTOCOL_PDF_BASE64);

export const PAPER_PROTOCOL_WORKSPACE_ROOT = '/mock/test/workspace/paper-protocol';
export const PAPER_PROTOCOL_PACKAGE_NAME = 'Protocols/Paper-derived cloning';
export const PAPER_PROTOCOL_PATH = `${PAPER_PROTOCOL_WORKSPACE_ROOT}/${PAPER_PROTOCOL_PACKAGE_NAME}/.forge/protocol.json`;
export const PAPER_PROTOCOL_ALTERNATE_PATH = `${PAPER_PROTOCOL_WORKSPACE_ROOT}/Protocols/Library construction/.forge/protocol.json`;
export const PAPER_PROTOCOL_PDF_FILE_NAME = 'paper-protocol-synthetic.pdf';
export const PAPER_PROTOCOL_PDF_PATH = `${PAPER_PROTOCOL_WORKSPACE_ROOT}/${PAPER_PROTOCOL_PDF_FILE_NAME}`;
export const PAPER_PROTOCOL_PDF_SHA256 =
  'ee66d2239b4b8134dc6d71873dbfae6c39c859353a361bdba59c977fa39eeb03';

const SOURCE_TEXT = 'Cells were lysed in 20 mM Tris at 4 °C and centrifuged for 30 min.';
const SUPPLEMENT_TEXT = 'Primer pExample_F was used at 10 µM.';
const HOLE_SOURCE_TEXT = 'The PCR cycling program was performed as described in reference 23.';

function tipTapText(text: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

export const PAPER_PROTOCOL_DOCUMENT = `${JSON.stringify(
  {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'paper-protocol-a9f27d96a32e291e28fb159c',
    title: 'Paper-derived cloning protocol',
    editable: true,
    overview: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Paper-derived protocol. Source wording is preserved verbatim; unresolved references are marked as holes.',
            },
          ],
        },
      ],
    },
    steps: [
      {
        id: 'paper-protocol-step-source',
        sourceStepId: 'source-span-protein-purification',
        ordinal: 1,
        title: 'Protein Purification',
        content: tipTapText(SOURCE_TEXT),
      },
      {
        id: 'paper-protocol-step-supplement',
        sourceStepId: 'source-span-table-s3',
        ordinal: 2,
        title: 'Resolved reference: Table S3',
        content: tipTapText(SUPPLEMENT_TEXT),
      },
      {
        id: 'paper-protocol-step-hole',
        sourceStepId: 'unresolved-paper-punt-reference-23',
        ordinal: 3,
        title: 'Hole: unresolved reference',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'UNRESOLVED REFERENCE — cited-paper fetching is outside this local-only slice.\n\nSource wording: ',
                },
                tipTapText(HOLE_SOURCE_TEXT).content[0].content[0],
              ],
            },
          ],
        },
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: `sha256:${PAPER_PROTOCOL_PDF_SHA256}`,
      pinnedVersionHash: 'sha256:3280235cdc84dc39e4d8e0c1cbe900f1f5edf50c6f17b0dd13d633a7bb697c5b',
      immutable: true,
      importedAt: '2026-08-18T12:00:00.000Z',
    },
    provenance: {
      immutableSource: true,
      provider: 'local-pdf',
      sourceObjectId: `pdf:${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
      stableSourceId: `pdf:${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
      sourceUrl: 'https://doi.org/10.1000/example',
      capturedAt: '2026-08-18T12:00:00.000Z',
    },
    paperProtocol: {
      schema: 'dnaforge.paper-protocol.v1',
      candidate: {
        candidateSetId: `paper-set-${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
        candidateId: 'paper-candidate-a9f27d96a32e291e28fb159c',
        ordinal: 1,
        label: 'Paper-derived cloning protocol',
        status: 'selected',
      },
      draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
      sources: [
        {
          sourceId: `pdf:${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
          kind: 'pdf',
          title: 'DNAForge Paper-to-Protocol Fixture',
          mediaType: 'application/pdf',
          sha256: `sha256:${PAPER_PROTOCOL_PDF_SHA256}`,
          capturedAt: '2026-08-18T12:00:00.000Z',
          workspacePath: PAPER_PROTOCOL_PDF_FILE_NAME,
          pageCount: 2,
        },
      ],
      evidence: [
        {
          evidenceId: 'paper-anchor-protein-purification',
          stepId: 'paper-protocol-step-source',
          sourceId: `pdf:${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
          sourceSha256: `sha256:${PAPER_PROTOCOL_PDF_SHA256}`,
          evidenceClass: 'direct',
          quote: 'Cells were lysed in 20 mM Tris at 4 C and centrifuged for 30 min.',
          locator: {
            kind: 'pdf_rects',
            page: 1,
            rects: [{ x: 0.1144, y: 0.1995, width: 0.5703, height: 0.0202 }],
          },
        },
        {
          evidenceId: 'paper-anchor-table-s3',
          stepId: 'paper-protocol-step-supplement',
          sourceId: `pdf:${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
          sourceSha256: `sha256:${PAPER_PROTOCOL_PDF_SHA256}`,
          evidenceClass: 'resolved_reference',
          quote: 'Primer pExample_F was used at 10 uM.',
          locator: {
            kind: 'pdf_rects',
            page: 2,
            rects: [{ x: 0.1144, y: 0.1237, width: 0.3562, height: 0.0202 }],
          },
        },
        {
          evidenceId: 'paper-anchor-reference-23',
          stepId: 'paper-protocol-step-hole',
          sourceId: `pdf:${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
          sourceSha256: `sha256:${PAPER_PROTOCOL_PDF_SHA256}`,
          evidenceClass: 'direct',
          quote: 'The PCR cycling program was performed as described in reference 23.',
          locator: {
            kind: 'pdf_rects',
            page: 1,
            rects: [{ x: 0.1144, y: 0.3662, width: 0.6242, height: 0.0202 }],
          },
        },
      ],
      gaps: [
        {
          gapId: 'paper-gap-reference-23',
          stepId: 'paper-protocol-step-hole',
          missing: 'Reference 23 was not present in the supplied source representation.',
          attemptedResolution: ['Preserved the citation as an explicit hole without guessing.'],
        },
      ],
      acceptedVersions: [],
    },
  },
  null,
  2
)}\n`;

export const PAPER_PROTOCOL_ALTERNATE_DOCUMENT = (() => {
  const raw = JSON.parse(PAPER_PROTOCOL_DOCUMENT) as Record<string, unknown>;
  raw.id = 'paper-protocol-library-construction';
  raw.title = 'Library construction candidate';
  const workflow = raw.paperProtocol as Record<string, unknown>;
  workflow.candidate = {
    candidateSetId: `paper-set-${PAPER_PROTOCOL_PDF_SHA256.slice(0, 24)}`,
    candidateId: 'paper-candidate-library-construction',
    ordinal: 2,
    label: 'Library construction candidate',
    status: 'proposed',
  };
  return `${JSON.stringify(raw, null, 2)}\n`;
})();

export function paperProtocolScenario(openDocument = true): AppScenario {
  const conversationId = 'paper-protocol-review-chat';
  return {
    files: {
      [PAPER_PROTOCOL_PATH]: PAPER_PROTOCOL_DOCUMENT,
      [PAPER_PROTOCOL_ALTERNATE_PATH]: PAPER_PROTOCOL_ALTERNATE_DOCUMENT,
      [PAPER_PROTOCOL_PDF_PATH]: PAPER_PROTOCOL_PDF,
    },
    workspace: {
      folders: [{ path: PAPER_PROTOCOL_WORKSPACE_ROOT, name: 'paper-protocol' }],
      selectedPath: PAPER_PROTOCOL_WORKSPACE_ROOT,
    },
    canvas: {
      tabs: [
        { type: 'chat', entityId: conversationId, label: 'Protocol extraction' },
        ...(openDocument
          ? [
              {
                type: 'pdf' as const,
                entityId: PAPER_PROTOCOL_PDF_PATH,
                label: 'Source paper',
              },
              {
                type: 'scientific-document' as const,
                entityId: PAPER_PROTOCOL_PATH,
                label: 'Paper-derived cloning',
              },
            ]
          : []),
      ],
      activeTabIndex: 0,
      layout: openDocument ? 'three-column' : 'single',
    },
    chat: {
      conversationId,
      messages: [
        {
          id: 'paper-protocol-user-request',
          role: 'user',
          content: 'Extract a runnable protocol from this paper and show me the evidence.',
          createdAt: 1,
        },
        {
          id: 'paper-protocol-agent-response',
          role: 'assistant',
          content:
            'I opened the paper-derived protocol beside this chat. Two source paths resolved locally and one cited-paper dependency remains an explicit hole.',
          createdAt: 2,
        },
      ],
    },
  };
}
