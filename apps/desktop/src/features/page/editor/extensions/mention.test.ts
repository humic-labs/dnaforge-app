/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mentionOpenIntentFromElement } from './mention';

function mentionEl(attrs: Record<string, string>): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mention';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe('mentionOpenIntentFromElement — the click-to-open fix', () => {
  it('returns an intent for a SEQUENCE mention (previously a dead chip)', () => {
    const el = mentionEl({
      'data-entity-type': 'sequence',
      'data-entity-id': 'sequences/circular/pUC19.gb',
      'data-label': 'pUC19',
    });
    expect(mentionOpenIntentFromElement(el)).toEqual({
      entityType: 'sequence',
      entityId: 'sequences/circular/pUC19.gb',
      label: 'pUC19',
      path: null,
      contentHash: null,
      objectUuid: null,
    });
  });

  it('returns an intent for a DESIGN mention (new entity kind)', () => {
    const el = mentionEl({
      'data-entity-type': 'design',
      'data-entity-id': 'designs/x.wpdesign.json',
      'data-label': 'My design',
    });
    expect(mentionOpenIntentFromElement(el)?.entityType).toBe('design');
  });

  it('still returns an intent for a PAGE mention', () => {
    const el = mentionEl({ 'data-entity-type': 'page', 'data-entity-id': 'page-123' });
    expect(mentionOpenIntentFromElement(el)).toEqual({
      entityType: 'page',
      entityId: 'page-123',
      label: '',
      path: null,
      contentHash: null,
      objectUuid: null,
    });
  });

  it('defaults entityType to page when the attr is absent', () => {
    const el = mentionEl({ 'data-entity-id': 'x' });
    expect(mentionOpenIntentFromElement(el)?.entityType).toBe('page');
  });

  it('returns null when there is nothing at all to open', () => {
    expect(mentionOpenIntentFromElement(mentionEl({ 'data-entity-type': 'sequence' }))).toBe(null);
  });

  it('returns null for a null element (click missed a mention)', () => {
    expect(mentionOpenIntentFromElement(null)).toBe(null);
  });
});

describe('mentionOpenIntentFromElement — record-only chips ', () => {
  it('opens a chip that carries only a path', () => {
    const el = mentionEl({
      'data-entity-type': 'sequence',
      'data-path': 'sequences/vectors/pUC19.gb',
      'data-label': 'pUC19',
    });

    const intent = mentionOpenIntentFromElement(el);

    expect(intent).not.toBeNull();
    expect(intent?.path).toBe('sequences/vectors/pUC19.gb');
    expect(intent?.entityId).toBeNull();
    expect(intent?.label).toBe('pUC19');
  });

  it('carries the content hash through when present', () => {
    const hash = `sha256:${'c'.repeat(64)}`;
    const el = mentionEl({
      'data-entity-type': 'sequence',
      'data-path': 'a/b.gb',
      'data-content-hash': hash,
    });

    expect(mentionOpenIntentFromElement(el)?.contentHash).toBe(hash);
  });

  it('carries both identifiers when the chip has both', () => {
    const el = mentionEl({
      'data-entity-type': 'sequence',
      'data-entity-id': 'entity-1',
      'data-path': 'a/b.gb',
    });

    const intent = mentionOpenIntentFromElement(el);
    expect(intent?.entityId).toBe('entity-1');
    expect(intent?.path).toBe('a/b.gb');
  });

  it('reports null path and hash for a legacy chip that has neither', () => {
    const el = mentionEl({ 'data-entity-type': 'page', 'data-entity-id': 'page-1' });

    const intent = mentionOpenIntentFromElement(el);
    expect(intent?.path).toBeNull();
    expect(intent?.contentHash).toBeNull();
  });
});

describe('mentionOpenIntentFromElement — the durable id', () => {
  it('carries data-object-uuid into the intent', () => {
    const el = mentionEl({
      'data-entity-type': 'sequence',
      'data-object-uuid': 'uuid-1',
      'data-path': 'a/b.gb',
    });
    expect(mentionOpenIntentFromElement(el)?.objectUuid).toBe('uuid-1');
  });

  it('opens a chip carrying ONLY a durable id', () => {
    const el = mentionEl({ 'data-entity-type': 'sequence', 'data-object-uuid': 'uuid-1' });
    const intent = mentionOpenIntentFromElement(el);
    expect(intent).not.toBeNull();
    expect(intent?.objectUuid).toBe('uuid-1');
  });

  it('is still null when it carries no identifier of any kind', () => {
    expect(mentionOpenIntentFromElement(mentionEl({ 'data-entity-type': 'sequence' }))).toBeNull();
  });
});
