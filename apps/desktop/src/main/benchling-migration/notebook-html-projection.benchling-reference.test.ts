import { describe, expect, it } from 'vitest';

import { buildNotebookHtmlProjection } from './notebook-html-projection';
import type { SourceObject } from '../../shared/benchling-migration';

const SOURCE_NOTEBOOK = 'etr_DemoEtr001';
const TARGET_SEQUENCE = 'seq_DemoSeq004';
const TARGET_NOTEBOOK = 'etr_DEMOET0004';
const BASE_URL = 'https://benchling.com/exampleowner';

function cardHtml(options: { targetId?: string; href?: string; name?: string } = {}): string {
  const name = options.name ?? 'Controlled Corpus Sequence — duplicate display name';
  const internalLink =
    options.targetId === undefined
      ? ''
      : ` data-internal-link='{"type":"sequence","id":"${options.targetId}"}'`;
  const href = options.href === undefined ? '' : ` href="${options.href}"`;
  return `<!doctype html><html><body>
    <div data-test-component="NoteDropTarget" data-test-element="noteLinkedFilePreview" class="note-entry">
      <a${href}${internalLink}><span data-test-element="previewItemName">${name}</span></a>
    </div>
  </body></html>`;
}

function sourceObject(html: string, overrides: Partial<SourceObject> = {}): SourceObject {
  return {
    id: SOURCE_NOTEBOOK,
    stableId: SOURCE_NOTEBOOK,
    sourceType: 'notebook_entry',
    name: 'Controlled Corpus A',
    aliases: [],
    sourceUrl: `${BASE_URL}/f/lib_x/${SOURCE_NOTEBOOK}-corpus-a/edit`,
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: { html },
    relationships: [],
    ...overrides,
  };
}

function project(html: string, overrides: Partial<SourceObject> = {}) {
  return buildNotebookHtmlProjection(sourceObject(html, overrides), {
    capturedAt: '2026-08-20T00:00:00.000Z',
    converterVersion: 'test',
    attachments: [],
    supportedFormulaNames: [],
  });
}

function embedsOfType(document: unknown, type: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (record.type === 'embed' && attrs?.type === type) found.push(attrs);
    for (const child of (record.content as unknown[]) ?? []) walk(child);
  };
  walk(document);
  return found;
}

describe('notebook projection — unresolved Benchling references', () => {
  it('emits a structured reference card instead of a generic artifact', () => {
    const result = project(cardHtml({ targetId: TARGET_SEQUENCE }));

    const references = embedsOfType(result.document.content, 'benchling-reference');
    expect(references).toHaveLength(1);
    expect(embedsOfType(result.document.content, 'source-artifact')).toHaveLength(0);
  });

  it('stores the exact target identity that a later import can repair', () => {
    const result = project(cardHtml({ targetId: TARGET_SEQUENCE }));
    const [reference] = embedsOfType(result.document.content, 'benchling-reference');
    const data = reference.data as Record<string, unknown>;

    expect(data.target).toMatchObject({
      provider: 'benchling',
      stableObjectId: TARGET_SEQUENCE,
      objectClass: 'sequence',
    });
    expect(data.sourceNotebookId).toBe(SOURCE_NOTEBOOK);
    expect(data.disposition).toBe('pending');
    expect(data.expectedObjectClass).toBe('sequence');
  });

  it('reads the identity from inline metadata when the anchor has no href at all', () => {
    const result = project(cardHtml({ targetId: TARGET_SEQUENCE }));
    const [reference] = embedsOfType(result.document.content, 'benchling-reference');
    expect((reference.data as Record<string, unknown>).target).toMatchObject({
      stableObjectId: TARGET_SEQUENCE,
    });
  });

  it('classifies a notebook target as a notebook, not a sequence', () => {
    const result = project(cardHtml({ targetId: TARGET_NOTEBOOK, name: 'Controlled Corpus B' }));
    const [reference] = embedsOfType(result.document.content, 'benchling-reference');
    expect((reference.data as Record<string, unknown>).target).toMatchObject({
      stableObjectId: TARGET_NOTEBOOK,
      objectClass: 'notebook',
    });
  });

  it('falls back to a generic artifact when the export recorded no exact identity', () => {
    const result = project(cardHtml({}));
    expect(embedsOfType(result.document.content, 'benchling-reference')).toHaveLength(0);
    expect(embedsOfType(result.document.content, 'source-artifact')).toHaveLength(1);
  });

  it.each(['seq_x', 'lib_DemoLib2', 'not-an-id'])(
    'refuses %s as a reference identity',
    (targetId) => {
      const result = project(cardHtml({ targetId }));
      expect(embedsOfType(result.document.content, 'benchling-reference')).toHaveLength(0);
    }
  );

  it('never stores an unsafe URL on the card', () => {
    const result = project(cardHtml({ targetId: TARGET_SEQUENCE, href: 'javascript:alert(1)' }));
    const [reference] = embedsOfType(result.document.content, 'benchling-reference');
    const data = reference.data as Record<string, unknown>;
    expect(data.sourceUrl).toBeNull();
    expect(JSON.stringify(data)).not.toContain('javascript:');
  });

  it('gives each occurrence its own deterministic id', () => {
    const html = `<!doctype html><html><body>
      ${cardHtml({ targetId: TARGET_SEQUENCE })}
      ${cardHtml({ targetId: TARGET_NOTEBOOK, name: 'Controlled Corpus B' })}
    </body></html>`;
    const first = embedsOfType(project(html).document.content, 'benchling-reference');
    const second = embedsOfType(project(html).document.content, 'benchling-reference');
    expect(first).toHaveLength(2);
    expect(first[0].refId).not.toBe(first[1].refId);
    expect(first.map((entry) => entry.refId)).toEqual(second.map((entry) => entry.refId));
  });
});

describe('ordinary anchors carrying a provider stable ID', () => {
  const anchorHtml = (href: string, label = 'pDEMO749') =>
    `<!doctype html><html><body><p><a href="${href}">${label}</a></p></body></html>`;

  function linkMarks(document: unknown): Array<Record<string, unknown>> {
    const found: Array<Record<string, unknown>> = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const marks = record.marks;
      if (Array.isArray(marks)) {
        for (const mark of marks as Array<Record<string, unknown>>) {
          if (mark.type === 'link') found.push((mark.attrs as Record<string, unknown>) ?? {});
        }
      }
      const content = record.content;
      if (Array.isArray(content)) for (const child of content) walk(child);
      else if (content && typeof content === 'object') walk(content);
    };
    walk(document);
    return found;
  }

  it('carries the stable ID and object class so the click can resolve later', () => {
    const projection = project(
      anchorHtml(
        'https://benchling.com/examplelab/f/lib_DemoLib1-registry/seq_DemoSeq2-pdemo749/edit'
      )
    );

    const [link] = linkMarks(projection.document);
    expect(link).toMatchObject({
      providerStableId: 'seq_DemoSeq2',
      providerObjectClass: 'sequence',
    });
    expect(link.href).toContain('seq_DemoSeq2-pdemo749');
  });

  it('recognises a notebook target as well as a sequence', () => {
    const projection = project(
      anchorHtml(
        `${BASE_URL}/f/lib_DEMOLB06-screening/${TARGET_NOTEBOOK}-cloning-corrected/edit`,
        'Cloning corrected'
      )
    );

    expect(linkMarks(projection.document)[0]).toMatchObject({
      providerStableId: TARGET_NOTEBOOK,
      providerObjectClass: 'notebook',
    });
  });

  it('leaves an ordinary link alone when its href names no stable object', () => {
    const projection = project(anchorHtml('https://benchling.com/exampleowner/search?q=plasmid'));

    const [link] = linkMarks(projection.document);
    expect(link.providerStableId ?? null).toBeNull();
    expect(link.href).toContain('search');
  });

  it('never treats a folder or library id as an object identity', () => {
    const projection = project(
      anchorHtml('https://benchling.com/exampleowner/f/lib_DemoLib1-registry')
    );

    expect(linkMarks(projection.document)[0].providerStableId ?? null).toBeNull();
  });
});
