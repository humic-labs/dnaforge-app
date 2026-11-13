import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ComponentProps } from 'react';
import type { FileContextMenu } from '../components/FileContextMenu';
import type { SequenceTabInfoChrome } from '../features/sequence/components/SequenceTabInfoChrome';
import {
  sequenceDisplayName,
  sequencePresentation,
  quickLookSequenceDisplayName,
  type SequenceDisplayName,
  type SequencePresentation,
} from './sequence-presentation';

describe('sequence presentation contract', () => {
  it.each([
    ['pBR322', 'pBR322'],
    ['  pBR322  ', 'pBR322'],
    ['pBR322.gb', 'pBR322'],
    ['pBR322 Follow-up.gb', 'pBR322 Follow-up'],
    ['pUC19.GENBANK', 'pUC19'],
    ['assembly.fasta.gz', 'assembly'],
    ['/imports/opaque-id.gb', 'opaque-id'],
    ['C:\\imports\\opaque-id.gbk', 'opaque-id'],
    ['pUC19.v2', 'pUC19.v2'],
    ['  pUC19  ', 'pUC19'],
    ['', 'Sequence'],
    [null, 'Sequence'],
    [undefined, 'Sequence'],
  ])('admits %s as %s', (input, expected) => {
    expect(sequenceDisplayName(input)).toBe(expected);
  });

  it('projects only the name, excluding identity values that can themselves be locators', () => {
    const resolved = {
      documentId: '/imports/private.gb',
      name: 'Named sequence',
      sourcePath: '/imports/private.gb',
      productPath: '/packages/private-product.gb',
      sourceFileName: 'private.gb',
    };
    expect(sequencePresentation(resolved.name)).toEqual({
      name: 'Named sequence',
    });
    expectTypeOf<SequencePresentation>().not.toHaveProperty('documentId');
    expectTypeOf<SequencePresentation>().not.toHaveProperty('sourceFileName');
    expectTypeOf<SequencePresentation>().not.toHaveProperty('productPath');
    expectTypeOf<string>().not.toExtend<SequenceDisplayName>();
    expectTypeOf<ComponentProps<typeof FileContextMenu>>().not.toHaveProperty('filePath');
    expectTypeOf<ComponentProps<typeof FileContextMenu>>().not.toHaveProperty('relativePath');
    expectTypeOf<ComponentProps<typeof FileContextMenu>>().not.toHaveProperty('fileName');
    expectTypeOf<ComponentProps<typeof SequenceTabInfoChrome>>().not.toHaveProperty('filePath');
    expectTypeOf<ComponentProps<typeof SequenceTabInfoChrome>>().not.toHaveProperty(
      'sourceFileName'
    );
    expectTypeOf<ComponentProps<typeof SequenceTabInfoChrome>>().not.toHaveProperty(
      'workspaceRootPath'
    );
    expectTypeOf<ComponentProps<typeof SequenceTabInfoChrome>>().not.toHaveProperty(
      'deepShareTargetReference'
    );
  });

  it('admits Quick Look source and record labels before rendering their controls', () => {
    expect(quickLookSequenceDisplayName('source.gb', 'record.fasta')).toBe(
      'Quick Look / source / record'
    );
  });
});
