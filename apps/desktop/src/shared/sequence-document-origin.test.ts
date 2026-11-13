// @vitest-environment node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseGenBankFull, serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import { parseSequenceFileAsDocument } from './parse-sequence-file';
import { createSequenceDocumentModel } from './sequence-document-model';

it('retains the real pUC19 origin through replacement, annotation undo and GenBank publication', () => {
  const path = fileURLToPath(
    new URL('../../../../test-fixtures/sequences/circular/pUC19.gb', import.meta.url)
  );
  const source = readFileSync(path, 'utf8');
  const original = parseGenBankFull(source);
  const model = createSequenceDocumentModel();
  const id = 'origin-publication';
  model.getState().setSequence(id, parseSequenceFileAsDocument(source, path).sequence);
  const prefix = original.sequence.startsWith('TTTT') ? 'AAAA' : 'TTTT';
  model.getState().replaceBases(id, 0, 4, prefix);
  model.getState().addAnnotation(id, {
    name: 'retained new annotation',
    type: 'misc_feature',
    start: 5,
    end: 8,
    direction: 1,
  });
  model.getState().dispatchEdit(id, { type: 'UNDO' });
  expect(model.getState().getSequence(id)?.annotations).toHaveLength(original.annotations.length);
  model.getState().dispatchEdit(id, { type: 'REDO' });
  const capture = model.getState().captureForSave(id)!;
  const reopened = parseGenBankFull(serializeSequenceForInPlaceSave(capture.sequence, path));
  expect(reopened.sequence).toBe(prefix + original.sequence.slice(4));
  expect(reopened.annotations).toHaveLength(original.annotations.length + 1);
  const origin = original.annotations.find(({ name }) => name === 'ori')!;
  expect(reopened.annotations.find(({ name }) => name === 'ori')).toMatchObject({
    name: origin.name,
    type: origin.type,
    start: origin.start,
    end: origin.end,
    direction: origin.direction,
    qualifiers: { note: origin.qualifiers?.note },
  });
  expect(readFileSync(path, 'utf8')).toBe(source);
});
