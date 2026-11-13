// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import type { SourceObject } from '../../shared/benchling-migration';
import { buildNotebookHtmlProjection } from './notebook-html-projection';
import {
  NotebookDocumentModel,
  notebookDocumentModelSchema,
} from '../../shared/notebook-model/document';
import { parseNotebookMarkdown, serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';

const retainedHtml = readFileSync(
  new URL('./fixtures/empty-material-nested-list.html', import.meta.url),
  'utf8'
);

function project(html: string): JSONContent {
  const source: SourceObject = {
    id: 'etr_ListFixture',
    stableId: 'etr_ListFixture',
    sourceType: 'notebook_entry',
    name: 'List schema fixture',
    aliases: [],
    sourceUrl: 'https://benchling.com/fixture/etr_ListFixture/edit',
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    relationships: [],
    content: { html },
  };
  return buildNotebookHtmlProjection(source, {
    capturedAt: '2026-11-03T00:00:00.000Z',
    converterVersion: 'list-schema-contract',
    attachments: [],
    supportedFormulaNames: [],
  }).document.content;
}

function nodes(content: JSONContent, type: string): JSONContent[] {
  return [
    ...(content.type === type ? [content] : []),
    ...(content.content ?? []).flatMap((child) => nodes(child, type)),
  ];
}
function text(content: JSONContent): string {
  return content.type === 'text'
    ? (content.text ?? '')
    : (content.content ?? []).map(text).join('');
}
function assertCanonicalLists(content: JSONContent): void {
  for (const item of nodes(content, 'listItem')) expect(item.content?.[0]?.type).toBe('paragraph');
  expect(() => notebookDocumentModelSchema().nodeFromJSON(content).check()).not.toThrow();
}
function nativeSaveStepAndRoundTrip(content: JSONContent): JSONContent {
  const model = new NotebookDocumentModel(
    { type: 'doc', content: [{ type: 'paragraph' }] },
    'List schema fixture'
  );
  model.execute({ kind: 'splice-blocks', index: 0, deleteCount: 1, blocks: content.content ?? [] });
  model.applySteps([]);
  assertCanonicalLists(model.content);
  const identity = { id: 'list-fixture', title: 'List schema fixture', formatVersion: 2 };
  const saved = serializeNotebookMarkdown({ identity, content: model.content });
  const parsed = parseNotebookMarkdown({
    markdown: saved.markdown,
    payloads: new Map(saved.payloads.map((payload) => [payload.relativePath, payload.content])),
    expected: identity,
  });
  const reopened = new NotebookDocumentModel(parsed.content, parsed.title);
  assertCanonicalLists(reopened.content);
  return reopened.content;
}

it('projects the exact retained empty material/component list into schema-valid native save steps', () => {
  expect(createHash('sha256').update(retainedHtml).digest('hex')).toBe(
    '51f4904250655db6fbe7b3f0962cf3cfee0d3474b0b5fb1157a1f12595044d86'
  );
  const projected = project(retainedHtml);
  expect(nodes(projected, 'bulletList')).toHaveLength(2);
  expect(nodes(projected, 'listItem')).toHaveLength(2);
  const saved = nativeSaveStepAndRoundTrip(projected);
  assertCanonicalLists(projected);
  expect(nodes(saved, 'bulletList')).toHaveLength(2);
  expect(nodes(saved, 'listItem')).toHaveLength(2);
  expect(text(saved)).toBe(text(projected));
});

it('preserves nested ordered/bullet structure and scientific text order when a list comes before parent text', () => {
  const projected = project(
    '<ol start="7"><li><ul><li><p>Extract bands: 250 bp</p></li></ul><p>Retain 10 µl sample</p></li><li><p>Extract bands: 250 bp</p></li></ol>'
  );
  expect(text(projected)).toBe('Extract bands: 250 bpRetain 10 µl sampleExtract bands: 250 bp');
  expect(nodes(projected, 'orderedList')[0].attrs?.start).toBe(7);
  expect(nodes(projected, 'bulletList')).toHaveLength(1);
  const saved = nativeSaveStepAndRoundTrip(projected);
  assertCanonicalLists(projected);
  expect(text(saved)).toBe(text(projected));
  expect(nodes(saved, 'orderedList')[0].attrs?.start).toBe(7);
  expect(nodes(saved, 'bulletList')).toHaveLength(1);
});

it('continues rejecting malformed listItem content instead of weakening the native schema', () => {
  const malformed: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(() => new NotebookDocumentModel(malformed, 'Invalid list')).toThrow(
    /Invalid content for node listItem/
  );
});
