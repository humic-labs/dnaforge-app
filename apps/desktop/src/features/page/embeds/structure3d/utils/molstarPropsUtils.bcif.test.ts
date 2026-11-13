import { expect, it } from 'vitest';
import { getMolstarPropsFromAttrs } from './molstarPropsUtils';
import { molecularViewAttrs } from './molecularView';
import { buildDefaultMolecularDocument } from '../../../../../shared/default-molecular-view';
import { getCurrentMolecularSnapshot } from '../../../../../shared/molecular-document';
import { binaryCoordinateText } from '../../../../../shared/binary-coordinates';

it('hands a binary CIF view to the viewer as its exact bytes ', async () => {
  const bytes = Uint8Array.from([131, 164, 100, 97, 116, 97, 0, 255, 7]);
  const document = await buildDefaultMolecularDocument({
    name: '1FS0',
    format: 'bcif',
    text: binaryCoordinateText(bytes),
    createdAt: 1,
    documentId: '11111111-1111-4111-8111-111111111111',
    referenceId: '22222222-2222-4222-8222-222222222222',
  });
  const attrs = molecularViewAttrs(
    'molecular-document:1FS0',
    getCurrentMolecularSnapshot(document)
  );
  expect(attrs.coordinateFormat).toBe('bcif');
  expect(getMolstarPropsFromAttrs('file', attrs).structureData).toEqual(bytes);

  const text = await buildDefaultMolecularDocument({
    name: '1ABC',
    format: 'pdb',
    text: 'ATOM\n',
    createdAt: 1,
    documentId: '33333333-3333-4333-8333-333333333333',
    referenceId: '44444444-4444-4444-8444-444444444444',
  });
  const textAttrs = molecularViewAttrs(
    'molecular-document:1ABC',
    getCurrentMolecularSnapshot(text)
  );
  expect(textAttrs.coordinateFormat).toBeUndefined();
  expect(getMolstarPropsFromAttrs('file', textAttrs).structureData).toBe('ATOM\n');
});
