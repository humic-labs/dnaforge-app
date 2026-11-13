/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';

import { getBaseExtensions, MentionExtension, EmbedNode } from './index';
import { NotebookDocumentModel, notebookDocumentModelSchema } from '../../notebook-document-model';

const schema = getSchema([...getBaseExtensions(), MentionExtension, EmbedNode] as never);

const MENTION_ATTRS = {
  id: null,
  label: 'pUC19',
  entityType: 'sequence',
  entityId: 'sequences/vectors/pUC19.gb',
};

function docWithMention(attrs: Record<string, unknown>): PMNode {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'we cut ' },
          { type: 'mention', attrs },
          { type: 'text', text: ' with EcoRI' },
        ],
      },
    ],
  });
}

function roundTrip(doc: PMNode): PMNode {
  const documentSchema = doc.type.schema;
  const fragment = DOMSerializer.fromSchema(documentSchema).serializeFragment(doc.content);
  const host = document.createElement('div');
  host.appendChild(fragment);
  const reparsed = document.createElement('div');
  reparsed.innerHTML = host.innerHTML;
  return PMDOMParser.fromSchema(documentSchema).parse(reparsed);
}

function mentionsIn(doc: PMNode): PMNode[] {
  const found: PMNode[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'mention') found.push(n);
    return true;
  });
  return found;
}

describe('mention survives an HTML round trip (the clipboard path)', () => {
  it('keeps pasted styles and Registry identity through native editing and clipboard export', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<p data-indent="2"><span style="background-color: rgb(240, 220, 180)">Dose</span> ' +
      '<span style="color: rgb(12, 34, 56)">amount</span> ' +
      '<span data-type="mention" data-label="Sequence" data-entity-type="sequence" ' +
      'data-entity-id="sequence-1" data-registry-kind="custom_sequence" ' +
      'data-project-id="project-7">Sequence</span></p>';
    const parsed = PMDOMParser.fromSchema(notebookDocumentModelSchema()).parse(host);
    const model = new NotebookDocumentModel(parsed.toJSON(), 'Copied note');
    const before = model.content;
    const paragraph = model.state.doc.firstChild!;
    expect(paragraph.attrs.indent).toBe(2);
    expect(paragraph.toJSON().content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Dose',
          marks: [{ type: 'highlight', attrs: { color: 'rgb(240, 220, 180)' } }],
        }),
        expect.objectContaining({
          text: 'amount',
          marks: [{ type: 'textColor', attrs: { color: 'rgb(12, 34, 56)' } }],
        }),
      ])
    );
    expect(mentionsIn(model.state.doc)[0].attrs).toMatchObject({
      entityId: 'sequence-1',
      registryKind: 'custom_sequence',
      projectId: 'project-7',
    });
    model.applySteps(model.state.tr.insertText('Edited ', 1).steps.map((step) => step.toJSON()));
    expect(roundTrip(model.state.doc).toJSON()).toEqual(model.content);
    model.execute({ kind: 'undo' });
    expect(model.content).toEqual(before);
  });
  it('serializes a chip that can be re-parsed as a mention node', () => {
    const before = docWithMention(MENTION_ATTRS);
    expect(mentionsIn(before)).toHaveLength(1);

    const after = roundTrip(before);
    const survived = mentionsIn(after);

    expect(
      survived,
      'the chip degraded to plain text — renderHTML must emit data-type="mention" ' +
        'so the inherited parseHTML rule span[data-type="mention"] can match'
    ).toHaveLength(1);
  });

  it('preserves entityType and entityId across the round trip', () => {
    const after = roundTrip(docWithMention(MENTION_ATTRS));
    const [mention] = mentionsIn(after);
    expect(mention?.attrs.entityType).toBe('sequence');
    expect(mention?.attrs.entityId).toBe('sequences/vectors/pUC19.gb');
    expect(mention?.attrs.label).toBe('pUC19');
  });

  it('keeps the .mention class — the hover plugin and every L3 selector need it', () => {
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      docWithMention(MENTION_ATTRS).content
    );
    const host = document.createElement('div');
    host.appendChild(fragment);
    expect(host.querySelector('.mention')).not.toBeNull();
  });

  it('keeps the surrounding text intact', () => {
    const after = roundTrip(docWithMention(MENTION_ATTRS));
    expect(after.textContent).toContain('we cut');
    expect(after.textContent).toContain('with EcoRI');
  });
});

const RECORD_ATTRS = {
  ...MENTION_ATTRS,
  entityId: null,
  path: 'sequences/vectors/pUC19.gb',
  contentHash: 'sha256:'.concat('a'.repeat(64)),
};

describe('the reference record survives the round trip  §2.5)', () => {
  it('preserves path and contentHash', () => {
    const after = roundTrip(docWithMention(RECORD_ATTRS));
    const [mention] = mentionsIn(after);

    expect(mention?.attrs.path).toBe('sequences/vectors/pUC19.gb');
    expect(mention?.attrs.contentHash).toBe(RECORD_ATTRS.contentHash);
  });

  it('emits them as data-path and data-content-hash', () => {
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      docWithMention(RECORD_ATTRS).content
    );
    const host = document.createElement('div');
    host.appendChild(fragment);
    const el = host.querySelector('.mention');

    expect(el?.getAttribute('data-path')).toBe('sequences/vectors/pUC19.gb');
    expect(el?.getAttribute('data-content-hash')).toBe(RECORD_ATTRS.contentHash);
  });

  it('carries a null entityId without emitting an empty attribute', () => {
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      docWithMention(RECORD_ATTRS).content
    );
    const host = document.createElement('div');
    host.appendChild(fragment);
    const el = host.querySelector('.mention');

    expect(el?.hasAttribute('data-entity-id')).toBe(false);

    const after = roundTrip(docWithMention(RECORD_ATTRS));
    expect(mentionsIn(after)).toHaveLength(1);
    expect(mentionsIn(after)[0]?.attrs.entityId).toBeNull();
  });

  it('defaults path and contentHash to null for a legacy chip that has neither', () => {
    const after = roundTrip(docWithMention(MENTION_ATTRS));
    const [mention] = mentionsIn(after);

    expect(mention?.attrs.path).toBeNull();
    expect(mention?.attrs.contentHash).toBeNull();
    expect(mention?.attrs.entityId).toBe('sequences/vectors/pUC19.gb');
  });
});
