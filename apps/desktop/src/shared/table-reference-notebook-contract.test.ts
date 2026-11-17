// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { notebookContentExtensions } from '../db/notebook-content-extensions';
import { parseNotebookMarkdown, serializeNotebookMarkdown } from '../db/notebook-markdown-codec';
import { richTableReference } from './table-document-reference';

const projectId = '01d10437-737f-4254-aa79-f982ee53c0ce';
const tableId = '164295ce-630f-4f85-9a62-fbc2cfcf0258';
const reference = richTableReference(projectId, tableId);
function contract() {
  const value = notebookContentExtensions.richBlock('table-reference');
  expect(value).toBeDefined();
  return value!;
}

describe('reference-only notebook table placement', () => {
  it('keeps live binding separate from embed or link presentation and retains unknown JSON metadata', () => {
    const block = contract();
    expect(block.currentVersion).toBe(1);
    for (const presentation of ['embed', 'link']) {
      const data = { reference, presentation, futurePlacement: { preserved: [1, 2] } };
      expect(block.parseData(data)).toEqual({ ok: true, data });
    }
    expect(notebookContentExtensions.richBlock('table')?.currentVersion).toBe(1);
  });

  it('rejects malformed owners, digest mismatches, future versions and copied inline cells', () => {
    const block = contract();
    const bad = [
      { reference: { ...reference, documentId: 'another identity' }, presentation: 'embed' },
      { reference: { ...reference, version: 2 }, presentation: 'embed' },
      {
        reference: {
          ...reference,
          binding: {
            kind: 'saved-version',
            savedVersionId: 'a'.repeat(64),
            sha256: `sha256:${'b'.repeat(64)}`,
          },
        },
        presentation: 'embed',
      },
      { reference, presentation: 'other' },
      { reference, presentation: 'embed', cells: [[{ value: 'second mutable copy' }]] },
    ];
    for (const data of bad) expect(block.parseData(data)).toMatchObject({ ok: false });
  });

  it('round-trips immutable saved-version references through actual canonical notebook Markdown', () => {
    contract();
    const digest = 'c'.repeat(64);
    const pin = richTableReference(projectId, tableId, {
      kind: 'saved-version',
      savedVersionId: digest,
      sha256: `sha256:${digest}`,
    });
    const content = {
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table-reference',
            version: 1,
            refId: 'pinned-table-placement',
            data: { reference: pin, presentation: 'embed', futurePlacement: 'retained' },
          },
        },
      ],
    };
    const encoded = serializeNotebookMarkdown({
      identity: { id: 'table-pin-notebook', title: 'Pinned results', formatVersion: 2 },
      content,
      roots: { workspaceRoot: '/project', packageRoot: '/project/Pinned results' },
    });
    const payloads = new Map(
      encoded.payloads.map((payload) => [payload.relativePath, payload.content])
    );
    const parsed = parseNotebookMarkdown({
      markdown: encoded.markdown,
      payloads,
      expected: { id: 'table-pin-notebook', formatVersion: 2 },
    });
    expect(parsed.content).toEqual(content);
  });
});
