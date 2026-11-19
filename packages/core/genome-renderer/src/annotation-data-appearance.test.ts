import { expect, it } from 'vitest';
import {
  annotationDataColorsByFeatureV1,
  compileAnnotationDataAppearanceV1,
  packAnnotationDataAppearanceBytesV1,
  sourceAnnotationAliasesV1,
} from './annotation-data-appearance';

it('admits source identifiers without display names and resolves compiler feature indices', () => {
  const aliases = sourceAnnotationAliasesV1({
    ID: 'gene-b0001',
    locus_tag: 'b0001',
    Name: 'thrL',
    gene: 'thrL',
  });
  expect(aliases).toEqual(['b0001', 'gene-b0001']);
  const resolved = annotationDataColorsByFeatureV1(
    [
      { featureIndex: 92, aliases },
      { featureIndex: 4, aliases: ['gene-b0002', 'b0002'] },
    ],
    {
      colors: new Map([
        ['gene-b0001', 0x440154],
        ['b0002', 0xfde725],
      ]),
    }
  );
  expect([
    ...packAnnotationDataAppearanceBytesV1(new Uint32Array([4, 92, 500, 92]), resolved, 0x9ca3af),
  ]).toEqual([253, 231, 37, 255, 68, 1, 84, 255, 156, 163, 175, 255, 68, 1, 84, 255]);
});

it('rejects aliases that resolve to different measurements', () => {
  expect(() =>
    annotationDataColorsByFeatureV1([{ featureIndex: 0, aliases: ['ID', 'locus'] }], {
      colors: new Map([
        ['ID', 0xff0000],
        ['locus', 0x0000ff],
      ]),
    })
  ).toThrow('conflicting measurements');
});

it('fingerprints content deterministically and changes identity for palette, sample, missing color and theme', async () => {
  const first = await compileAnnotationDataAppearanceV1({
    colors: [
      ['b', 0x123456],
      ['a', 0xabcdef],
    ],
    themeMode: 'light',
  });
  const reordered = await compileAnnotationDataAppearanceV1({
    colors: [
      ['a', 0xabcdef],
      ['b', 0x123456],
    ],
    themeMode: 'light',
  });
  expect(reordered.fingerprint).toBe(first.fingerprint);
  for (const changed of [
    {
      colors: [
        ['b', 0x123457],
        ['a', 0xabcdef],
      ] as const,
      themeMode: 'light' as const,
    },
    {
      colors: [
        ['b', 0x123456],
        ['a', 0xabcdef],
      ] as const,
      themeMode: 'dark' as const,
    },
    {
      colors: [
        ['b', 0x123456],
        ['a', 0xabcdef],
      ] as const,
      themeMode: 'light' as const,
      missingColor: 0x9ca3af,
    },
  ])
    expect((await compileAnnotationDataAppearanceV1(changed)).fingerprint).not.toBe(
      first.fingerprint
    );
});
