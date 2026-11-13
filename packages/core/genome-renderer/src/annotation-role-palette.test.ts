import { describe, expect, it } from 'vitest';

import {
  FEATURE_TYPE_COLORS,
  DEFAULT_FEATURE_COLOR,
  isTranscriptSourceType,
} from './feature-colors';
import { buildTranscriptGlyphBlocks } from './renderers/pixi/overview/transcript-glyph-vertices';
import {
  ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1,
  AnnotationRolePaletteBuilderV1,
  isAnnotationColorRoleKeyV1,
  markAnnotationRoleCodedInstancesV1,
  packAnnotationRolePaletteMat4V1,
  packAnnotationRolePaletteVec4ArrayV1,
  resolveAnnotationRoleColorV1,
  sourceShapeRoleKeyV1,
} from './annotation-role-palette';
import { indexedAnnotationColorForRuntimeTheme } from './renderers/pixi/shared/annotation-runtime-theme';
import { webglAnnotationColorForMode } from './renderers/pixi/shared/theme';

const THEMES = ['light', 'dark'] as const;
const TRANSCRIPT_TYPES = [
  'mRNA',
  'transcript',
  'lncRNA',
  'lnc_RNA',
  'ncRNA',
  'miRNA',
  'snoRNA',
  'snRNA',
  'tRNA',
  'rRNA',
  'antisense_RNA',
  'gene',
];

function blocksFor(type: string, themeMode: 'light' | 'dark') {
  return buildTranscriptGlyphBlocks(
    [
      {
        type,
        direction: 'forward',
        exons: [
          { start: 1, end: 100 },
          { start: 201, end: 300 },
        ],
        cds: [{ start: 50, end: 250 }],
      },
    ],
    { getOffset: () => -7, halfHeight: 7, themeMode, cdsDetail: 0 }
  );
}

describe('annotation colour roles', () => {
  it('resolve every transcript glyph block to exactly the colour it paints', () => {
    for (const type of TRANSCRIPT_TYPES) {
      for (const theme of THEMES) {
        const blocks = blocksFor(type, theme);
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
          expect(isAnnotationColorRoleKeyV1(block.role)).toBe(true);
          expect(resolveAnnotationRoleColorV1(block.role, theme)).toBe(block.color);
        }
      }
    }
  });

  it('keep one role per glyph kind whatever the theme', () => {
    for (const type of TRANSCRIPT_TYPES) {
      expect(blocksFor(type, 'light').map((block) => block.role)).toEqual(
        blocksFor(type, 'dark').map((block) => block.role)
      );
    }
  });

  it('resolve source shapes through the themed type colour', () => {
    const colors = [...new Set([...Object.values(FEATURE_TYPE_COLORS), DEFAULT_FEATURE_COLOR])];
    for (const color of colors) {
      const role = sourceShapeRoleKeyV1(color);
      expect(isAnnotationColorRoleKeyV1(role)).toBe(true);
      for (const theme of THEMES) {
        expect(resolveAnnotationRoleColorV1(role, theme)).toBe(
          webglAnnotationColorForMode(color, theme)
        );
      }
    }
    expect(() => sourceShapeRoleKeyV1(0x1000000)).toThrow();
  });

  it('reject malformed persisted role keys', () => {
    for (const bad of [
      '',
      'transcript:exon',
      'rna-accent:unknown',
      'source:ABCDEF',
      'source:12345',
      3,
    ]) {
      expect(isAnnotationColorRoleKeyV1(bad)).toBe(false);
    }
  });

  it('number roles in first-use order and pack them as palette columns', () => {
    const builder = new AnnotationRolePaletteBuilderV1();
    expect(builder.indexOf('transcript:intron')).toBe(0);
    expect(builder.indexOf('transcript:cdsThick')).toBe(1);
    expect(builder.indexOf('transcript:intron')).toBe(0);
    expect(builder.roles).toEqual(['transcript:intron', 'transcript:cdsThick']);

    const matrix = packAnnotationRolePaletteMat4V1(builder.roles, 'light');
    expect(matrix).toHaveLength(16);
    const intron = resolveAnnotationRoleColorV1('transcript:intron', 'light');
    expect(Array.from(matrix.slice(0, 4))).toEqual([
      Math.fround(((intron >> 16) & 0xff) / 255),
      Math.fround(((intron >> 8) & 0xff) / 255),
      Math.fround((intron & 0xff) / 255),
      0,
    ]);
    expect(Array.from(matrix.slice(8))).toEqual(new Array(8).fill(0));
    expect(() =>
      packAnnotationRolePaletteMat4V1(
        [
          'transcript:intron',
          'transcript:utr',
          'transcript:cdsThick',
          'rna-accent:none',
          'source:000000',
        ],
        'light'
      )
    ).toThrow('four-weight');
  });

  it('shade a light-basis glyph by role exactly as the baked runtime projection did', () => {
    const channelDelta = (left: number, right: number) =>
      Math.max(
        ...[16, 8, 0].map((shift) => Math.abs(((left >> shift) & 0xff) - ((right >> shift) & 0xff)))
      );
    for (const type of TRANSCRIPT_TYPES.filter(isTranscriptSourceType)) {
      for (const block of blocksFor(type, 'light')) {
        for (const theme of THEMES) {
          const projected = indexedAnnotationColorForRuntimeTheme(block.color, type, theme);
          expect(
            channelDelta(resolveAnnotationRoleColorV1(block.role, theme), projected),
            `${type} ${block.role} ${theme}`
          ).toBeLessThanOrEqual(1);
        }
      }
    }
    for (const color of new Set([...Object.values(FEATURE_TYPE_COLORS), DEFAULT_FEATURE_COLOR])) {
      for (const theme of THEMES) {
        expect(
          channelDelta(
            resolveAnnotationRoleColorV1(sourceShapeRoleKeyV1(color), theme),
            indexedAnnotationColorForRuntimeTheme(color, 'gene', theme)
          )
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('let overrides replace chosen roles in every theme and leave the rest', () => {
    const overrides = { 'transcript:utr': 0x123456 } as const;
    for (const theme of THEMES) {
      expect(resolveAnnotationRoleColorV1('transcript:utr', theme, overrides)).toBe(0x123456);
      expect(resolveAnnotationRoleColorV1('transcript:intron', theme, overrides)).toBe(
        resolveAnnotationRoleColorV1('transcript:intron', theme)
      );
    }
    const palette = packAnnotationRolePaletteVec4ArrayV1(
      ['transcript:intron', 'transcript:utr'],
      'dark',
      overrides
    );
    expect(palette).toHaveLength(ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 * 4);
    expect(Array.from(palette.slice(4, 8))).toEqual([
      Math.fround(0x12 / 255),
      Math.fround(0x34 / 255),
      Math.fround(0x56 / 255),
      0,
    ]);
    expect(Array.from(palette.slice(8))).toEqual(new Array(palette.length - 8).fill(0));
    expect(() =>
      packAnnotationRolePaletteVec4ArrayV1(
        new Array(ANNOTATION_ROLE_PALETTE_MAX_SHADED_ROLES_V1 + 1).fill('transcript:intron'),
        'light'
      )
    ).toThrow('shader palette');
  });

  it('mark only the red channel of each glyph record with its role', () => {
    const stride = 12;
    const records = Float32Array.from({ length: stride * 3 }, (_, index) => index / 100);
    const before = Float32Array.from(records);
    markAnnotationRoleCodedInstancesV1(records, Uint8Array.of(0, 2, 1), stride, 8);
    expect([records[8], records[20], records[32]]).toEqual([-1, -3, -2]);
    for (let index = 0; index < records.length; index++) {
      if (index % stride !== 8) expect(records[index]).toBe(before[index]);
    }
    markAnnotationRoleCodedInstancesV1(records, Uint8Array.of(0, 2, 1), stride, 8);
    expect([records[8], records[20], records[32]]).toEqual([-1, -3, -2]);
    expect(() => markAnnotationRoleCodedInstancesV1(records, Uint8Array.of(0), stride, 8)).toThrow(
      'parallel'
    );
  });
});
