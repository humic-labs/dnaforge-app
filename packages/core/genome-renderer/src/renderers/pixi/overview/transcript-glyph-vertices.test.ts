import { describe, it, expect } from 'vitest';
import {
  buildTranscriptGlyphBlocks,
  packTranscriptGlyphVertices,
  TRANSCRIPT_COLORS,
  type TranscriptGlyphFeature,
} from './transcript-glyph-vertices';
import { webglAnnotationColorForMode } from '../shared/theme';
import { DARK_RNA_FAMILY_COLORS, annotationTypeAccentColor } from '../../../feature-colors';
import { packedBpRelativeToOrigin, unpackBpCoordinate } from './bp-coordinate-packing';

const ctx = (over: Partial<Parameters<typeof buildTranscriptGlyphBlocks>[1]> = {}) => ({
  getOffset: () => 20,
  halfHeight: 7,
  themeMode: 'light' as const,
  cdsDetail: 0,
  ...over,
});

describe('buildTranscriptGlyphBlocks — drawTranscriptGlyph fidelity', () => {
  it('forward coding 2-exon: connector + UTR/CDS split, last part pointed', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'forward',
      exons: [
        { start: 101, end: 200 },
        { start: 301, end: 400 },
      ],
      cds: [{ start: 151, end: 350 }],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx());

    expect(blocks[0]).toMatchObject({ startBp: 200, endBp: 300, dirSign: 0 });
    expect(blocks[0].halfH).toBeCloseTo(Math.max(0.5, 7 * 0.12), 6);
    expect(blocks[0].alpha).toBeCloseTo(0.85 * 0.7, 6);
    expect(blocks[0].color).toBe(
      webglAnnotationColorForMode(TRANSCRIPT_COLORS.light.intron, 'light')
    );

    const e0 = blocks.slice(1, 3);
    expect(e0[0]).toMatchObject({ startBp: 100, endBp: 150, dirSign: 0 });
    expect(e0[0].halfH).toBeCloseTo(Math.max(2, 7 * 0.62), 6);
    expect(e0[0].cdsFade).toBe(0);
    expect(e0[1]).toMatchObject({ startBp: 150, endBp: 200, dirSign: 1 });
    expect(e0[1].halfH).toBe(7);
    expect(e0[1].cdsFade).toBeCloseTo(0.85, 6);
    expect(e0[1].color).toBe(
      webglAnnotationColorForMode(TRANSCRIPT_COLORS.light.cdsThick, 'light')
    );

    const e1 = blocks.slice(3, 5);
    expect(e1[0]).toMatchObject({ startBp: 300, endBp: 350, dirSign: 0 });
    expect(e1[1]).toMatchObject({ startBp: 350, endBp: 400, dirSign: 1 });
  });

  it('emits one connector block per intron gap, not one transcript-wide body', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'none',
      exons: [
        { start: 101, end: 200 },
        { start: 401, end: 500 },
        { start: 801, end: 1000 },
      ],
      cds: [],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx());
    const connectorBlocks = blocks.filter(
      (block) =>
        block.color === webglAnnotationColorForMode(TRANSCRIPT_COLORS.light.intron, 'light')
    );

    expect(connectorBlocks).toHaveLength(2);
    expect(connectorBlocks.map((block) => [block.startBp, block.endBp])).toEqual([
      [200, 400],
      [500, 800],
    ]);
  });

  it('reverse: the FIRST part of each exon is the pointed one', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'reverse',
      exons: [{ start: 101, end: 400 }],
      cds: [{ start: 151, end: 350 }],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx());
    expect(blocks[0]).toMatchObject({ startBp: 100, endBp: 150, dirSign: -1 });
    expect(blocks[1].dirSign).toBe(0);
    expect(blocks[2].dirSign).toBe(0);
  });

  it('non-coding transcript: no CDS blocks, ncRNA colour, whole exons UTR', () => {
    const f: TranscriptGlyphFeature = {
      type: 'lncRNA',
      direction: 'forward',
      exons: [{ start: 1, end: 100 }],
      cds: [],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].color).toBe(
      webglAnnotationColorForMode(TRANSCRIPT_COLORS.light.ncRnaExon, 'light')
    );
    expect(blocks[0]).toMatchObject({ startBp: 0, endBp: 100, dirSign: 1 });
  });

  it('single-exon transcript emits no intron connector', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'none',
      exons: [{ start: 1, end: 100 }],
      cds: [],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].dirSign).toBe(0);
  });

  it('contract-less feature (getOffset → null) is SKIPPED, never throws', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'forward',
      exons: [{ start: 1, end: 100 }],
    };
    const ok: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'forward',
      exons: [{ start: 200, end: 300 }],
    };
    let calls = 0;
    const blocks = buildTranscriptGlyphBlocks(
      [f, ok],
      ctx({
        getOffset: () => {
          calls += 1;
          return calls === 1 ? null : 20;
        },
      })
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startBp: 199, endBp: 300 });
  });

  it('outline-only spliced features are NOT batched (stay on Graphics)', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'forward',
      exons: [{ start: 1, end: 100 }],
      outlineOnly: true,
    };
    expect(buildTranscriptGlyphBlocks([f], ctx())).toHaveLength(0);
  });

  it('dark theme switches the palette', () => {
    const f: TranscriptGlyphFeature = {
      type: 'mRNA',
      direction: 'forward',
      exons: [{ start: 1, end: 50 }],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx({ themeMode: 'dark' }));
    expect(blocks[0].color).toBe(0x2c6790);
    expect(blocks[0].color).not.toBe(
      webglAnnotationColorForMode(TRANSCRIPT_COLORS.dark.utr, 'dark')
    );
  });

  it('uses the exact same final dark non-coding color as the search badge accent', () => {
    const f: TranscriptGlyphFeature = {
      type: 'lncRNA',
      direction: 'forward',
      exons: [{ start: 1, end: 50 }],
    };
    const blocks = buildTranscriptGlyphBlocks([f], ctx({ themeMode: 'dark' }));

    expect(blocks[0].color).toBe(annotationTypeAccentColor('lncRNA', 'dark'));
  });

  it('uses the user-facing RNA track identity when the source type is the ncRNA umbrella', () => {
    const blocks = buildTranscriptGlyphBlocks(
      [
        {
          type: 'ncRNA',
          annotationTrackId: 'miRNA',
          direction: 'forward',
          exons: [{ start: 1, end: 50 }],
        },
      ],
      ctx({ themeMode: 'dark' })
    );

    expect(blocks[0].color).toBe(DARK_RNA_FAMILY_COLORS.micro);
  });
});

describe('packTranscriptGlyphVertices — fan layout the shader expects', () => {
  it('arrow blocks use 9 verts/block, fan corners [0,1,2,0,2,3,0,3,4], rgba + dirSign propagated', () => {
    const blocks = [
      {
        startBp: 10,
        endBp: 90,
        offsetCenter: 20,
        halfH: 7,
        color: 0x123456,
        alpha: 0.5,
        cdsFade: 0.85,
        dirSign: 1 as const,
      },
    ];
    const v = packTranscriptGlyphVertices(blocks);
    expect(v.bpStartChunk.length).toBe(9);
    expect(v.bpStartDelta.length).toBe(9);
    expect(v.bpEndChunk.length).toBe(9);
    expect(v.bpEndDelta.length).toBe(9);
    expect(Array.from(v.corner)).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4]);
    for (let i = 0; i < 9; i++) {
      expect(unpackBpCoordinate(v.bpStartChunk[i], v.bpStartDelta[i])).toBe(10);
      expect(unpackBpCoordinate(v.bpEndChunk[i], v.bpEndDelta[i])).toBe(90);
      expect(v.offsetCenter[i]).toBe(20);
      expect(v.halfH[i]).toBe(7);
      expect(v.dirSign[i]).toBe(1);
      expect(v.cdsFade[i]).toBeCloseTo(0.85, 6);
      expect(v.color[i * 4]).toBeCloseTo(0x12 / 255, 6);
      expect(v.color[i * 4 + 1]).toBeCloseTo(0x34 / 255, 6);
      expect(v.color[i * 4 + 2]).toBeCloseTo(0x56 / 255, 6);
      expect(v.color[i * 4 + 3]).toBe(0.5);
    }
  });

  it('plain rectangle blocks use 6 verts/block', () => {
    const v = packTranscriptGlyphVertices([
      {
        startBp: 10,
        endBp: 90,
        offsetCenter: 20,
        halfH: 7,
        color: 0x123456,
        alpha: 0.5,
        cdsFade: 0,
        dirSign: 0,
      },
    ]);
    expect(v.bpStartChunk.length).toBe(6);
    expect(Array.from(v.corner)).toEqual([0, 1, 3, 0, 3, 4]);
  });

  it('empty → empty buffers', () => {
    const v = packTranscriptGlyphVertices([]);
    expect(v.bpStartChunk.length).toBe(0);
    expect(v.bpStartDelta.length).toBe(0);
    expect(v.bpEndChunk.length).toBe(0);
    expect(v.bpEndDelta.length).toBe(0);
    expect(v.color.length).toBe(0);
  });

  it('packs chr1-scale bp coordinates without float32 absolute-coordinate drift', () => {
    const absolute = new Float32Array([248_000_123])[0];
    expect(absolute).not.toBe(248_000_123);

    const v = packTranscriptGlyphVertices([
      {
        startBp: 248_000_123,
        endBp: 248_000_457,
        offsetCenter: 20,
        halfH: 7,
        color: 0x123456,
        alpha: 0.5,
        cdsFade: 0,
        dirSign: 0,
      },
    ]);

    expect(unpackBpCoordinate(v.bpStartChunk[0], v.bpStartDelta[0])).toBe(248_000_123);
    expect(unpackBpCoordinate(v.bpEndChunk[0], v.bpEndDelta[0])).toBe(248_000_457);
    expect(
      packedBpRelativeToOrigin(
        v.bpStartChunk[0],
        v.bpStartDelta[0],
        v.bpStartChunk[0],
        v.bpStartDelta[0]
      )
    ).toBe(0);
    expect(
      packedBpRelativeToOrigin(
        v.bpEndChunk[0],
        v.bpEndDelta[0],
        v.bpStartChunk[0],
        v.bpStartDelta[0]
      )
    ).toBe(334);
  });
});
