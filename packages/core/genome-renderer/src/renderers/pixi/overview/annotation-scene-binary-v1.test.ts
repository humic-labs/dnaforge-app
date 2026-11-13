import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_SCENE_BINARY_V1,
  ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES,
  packAnnotationSceneBinaryV1,
  unpackAnnotationSceneBinaryV1,
  validateAnnotationSceneBinaryV1,
  type AnnotationSceneBinaryManifestV1,
  type AnnotationScenePrimitiveV1,
  type AnnotationShapeFamilyV1,
} from './annotation-scene-binary-v1';

const families: AnnotationShapeFamilyV1[] = [
  {
    id: 'transcript-glyph-v2',
    kind: 'transcript',
    metadata: { glyph: 'directional-exon', connector: true },
  },
  {
    id: 'enhancer-source-shape',
    kind: 'source-shape',
    metadata: {
      source: 'ENCODE',
      shape: { primitive: 'rounded-chevron', radii: [1, 2, 3] },
      style: { fill: '#7c3aed', flags: { outlined: false, selected: null } },
    },
  },
];

const primitives: AnnotationScenePrimitiveV1[] = [
  {
    startBp: 248_000_123,
    endBp: 248_000_457,
    featureIndex: 0,
    offsetCenter: 20,
    halfH: 7,
    color: 0x123456,
    alpha: 0.5,
    cdsFade: 0.85,
    dirSign: 1,
  },
  {
    startBp: 40_000_000_003,
    endBp: 40_000_001_003,
    featureIndex: 2,
    offsetCenter: -4.25,
    halfH: 1.25,
    color: 0xfedcba,
    alpha: 0.595,
    cdsFade: 0,
    dirSign: -1,
  },
];

const input = () => ({
  datasetContract: {
    datasetId: 'gencode-v47-grch38',
    datasetVersion: '47',
    sourceSha256: 'a'.repeat(64),
  },
  assemblyContract: {
    assemblyId: 'large-lungfish-safe-assembly',
    assemblyLengthBp: 43_088_269_832,
  },
  families,
  featureFamilyIndices: [0, 1, 1],
  primitives,
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('annotation-scene-binary.v1 pack/unpack', () => {
  it('writes the complete dataset/assembly/geometry contract and round-trips exactly', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());

    expect(packed.manifest.schema).toBe(ANNOTATION_SCENE_BINARY_V1);
    expect(packed.manifest.assemblyContract.assemblyLengthBp).toBeGreaterThan(0xffff_ffff);
    expect(packed.manifest.datasetContract).toEqual(input().datasetContract);
    expect(packed.manifest.assemblyContract).toEqual(input().assemblyContract);
    expect(packed.manifest.geometryContract).toEqual({
      geometryId: 'retained-linear-directional-block.v1',
      coordinateSpace: 'assembly-global-bp',
      coordinateSystem: 'zero-based-half-open',
      coordinateEncoding: 'uint64-le-number-safe',
      floatEncoding: 'float32-le',
      colorEncoding: 'rgb24-with-direction-byte',
      primitiveRecordBytes: 40,
    });
    expect(packed.manifest.sections.primitives).toEqual({
      byteOffset: 0,
      byteLength: primitives.length * ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES,
      count: primitives.length,
      recordBytes: ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES,
    });
    expect(packed.manifest.sections.featureFamilies).toEqual({
      byteOffset: primitives.length * ANNOTATION_SCENE_PRIMITIVE_RECORD_BYTES,
      byteLength: 3 * Uint32Array.BYTES_PER_ELEMENT,
      count: 3,
      recordBytes: Uint32Array.BYTES_PER_ELEMENT,
    });
    expect(packed.manifest.families).toEqual(families);
    expect(packed.manifest.integrity.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(packed.manifest.integrity.contractSha256).toMatch(/^[0-9a-f]{64}$/);

    const unpacked = await unpackAnnotationSceneBinaryV1(packed.manifest, packed.payload);
    expect(unpacked.featureFamilyIndices).toEqual(new Uint32Array([0, 1, 1]));
    expect(unpacked.families).toEqual(families);
    expect(unpacked.primitives.map((primitive) => primitive.startBp)).toEqual([
      248_000_123, 40_000_000_003,
    ]);
    expect(unpacked.primitives.map((primitive) => primitive.endBp)).toEqual([
      248_000_457, 40_000_001_003,
    ]);
    expect(unpacked.primitives.map((primitive) => primitive.featureIndex)).toEqual([0, 2]);
    for (let i = 0; i < primitives.length; i++) {
      expect(unpacked.primitives[i]).toEqual({
        ...primitives[i],
        offsetCenter: Math.fround(primitives[i].offsetCenter),
        halfH: Math.fround(primitives[i].halfH),
        alpha: Math.fround(primitives[i].alpha),
        cdsFade: Math.fround(primitives[i].cdsFade),
      });
    }
  });

  it('has a pinned 40-byte little-endian primitive golden', async () => {
    const packed = await packAnnotationSceneBinaryV1({
      ...input(),
      assemblyContract: { assemblyId: 'golden', assemblyLengthBp: 100_000_000 },
      primitives: [
        {
          startBp: 0x01020304,
          endBp: 0x05060708,
          featureIndex: 2,
          offsetCenter: 1.5,
          halfH: 7,
          color: 0x123456,
          alpha: 0.5,
          cdsFade: 0.75,
          dirSign: -1,
        },
      ],
    });
    expect(Array.from(packed.payload.subarray(0, 40))).toEqual([
      0x04, 0x03, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x08, 0x07, 0x06, 0x05, 0x00, 0x00, 0x00,
      0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x3f, 0x00, 0x00, 0xe0, 0x40, 0x56, 0x34,
      0x12, 0x02, 0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x40, 0x3f,
    ]);
  });

  it('canonicalizes arbitrary source-shape metadata key order into stable hashes', async () => {
    const first = await packAnnotationSceneBinaryV1(input());
    const reordered = input();
    reordered.families = [
      families[0],
      {
        ...families[1],
        metadata: {
          style: { flags: { selected: null, outlined: false }, fill: '#7c3aed' },
          shape: { radii: [1, 2, 3], primitive: 'rounded-chevron' },
          source: 'ENCODE',
        },
      },
    ];
    const second = await packAnnotationSceneBinaryV1(reordered);
    expect(second.manifest.integrity).toEqual(first.manifest.integrity);
    expect(second.payload).toEqual(first.payload);
  });
});

describe('annotation-scene-binary.v1 validator rejection', () => {
  it('rejects payload corruption by hash before unpacking', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());
    const corrupt = packed.payload.slice();
    corrupt[3] ^= 0xff;
    await expect(validateAnnotationSceneBinaryV1(packed.manifest, corrupt)).rejects.toThrow(
      /payload sha256 mismatch/
    );
  });

  it('rejects a forged hash', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());
    const corrupt = structuredClone(packed.manifest);
    corrupt.integrity.payloadSha256 = '0'.repeat(64);
    await expect(validateAnnotationSceneBinaryV1(corrupt, packed.payload)).rejects.toThrow(
      /payload sha256 mismatch/
    );
  });

  it('rejects corrupt and overlapping section offsets', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());
    const corrupt = structuredClone(packed.manifest);
    corrupt.sections.primitives.byteOffset = 4;
    await expect(validateAnnotationSceneBinaryV1(corrupt, packed.payload)).rejects.toThrow(
      /primitive section must begin at byte 0/
    );

    const overlap = structuredClone(packed.manifest);
    overlap.sections.featureFamilies.byteOffset = 4;
    await expect(validateAnnotationSceneBinaryV1(overlap, packed.payload)).rejects.toThrow(
      /feature-family section must immediately follow primitives/
    );
  });

  it('rejects geometry contract drift and manifest metadata mutation', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());
    const geometryDrift = structuredClone(packed.manifest);
    geometryDrift.geometryContract.coordinateSystem = 'one-based-inclusive' as never;
    await expect(validateAnnotationSceneBinaryV1(geometryDrift, packed.payload)).rejects.toThrow(
      /geometry coordinate system/
    );

    const metadataDrift = structuredClone(packed.manifest);
    (metadataDrift.families[1].metadata as { source: string }).source = 'forged';
    await expect(validateAnnotationSceneBinaryV1(metadataDrift, packed.payload)).rejects.toThrow(
      /contract sha256 mismatch/
    );
  });

  it('rejects invalid dataset, assembly, feature, coordinate, and JSON metadata contracts', async () => {
    await expect(
      packAnnotationSceneBinaryV1({
        ...input(),
        datasetContract: { ...input().datasetContract, datasetId: '' },
      })
    ).rejects.toThrow(/datasetId/);
    await expect(
      packAnnotationSceneBinaryV1({
        ...input(),
        assemblyContract: {
          ...input().assemblyContract,
          assemblyLengthBp: Number.MAX_SAFE_INTEGER + 1,
        },
      })
    ).rejects.toThrow(/assemblyLengthBp/);
    await expect(
      packAnnotationSceneBinaryV1({
        ...input(),
        primitives: [{ ...primitives[0], featureIndex: 3 }],
      })
    ).rejects.toThrow(/featureIndex/);
    await expect(
      packAnnotationSceneBinaryV1({
        ...input(),
        primitives: [{ ...primitives[0], endBp: input().assemblyContract.assemblyLengthBp + 1 }],
      })
    ).rejects.toThrow(/endBp/);
    await expect(
      packAnnotationSceneBinaryV1({
        ...input(),
        families: [families[0], { ...families[1], metadata: { invalid: Number.NaN } as never }],
      })
    ).rejects.toThrow(/finite JSON number/);
  });

  it('rejects uint64 coordinates above Number.MAX_SAFE_INTEGER during unpack', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());
    const corruptPayload = packed.payload.slice();
    const view = new DataView(
      corruptPayload.buffer,
      corruptPayload.byteOffset,
      corruptPayload.byteLength
    );
    view.setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    const rehashed = structuredClone(packed.manifest);
    rehashed.integrity.payloadSha256 = await sha256Hex(corruptPayload);
    await expect(unpackAnnotationSceneBinaryV1(rehashed, corruptPayload)).rejects.toThrow(
      /startBp exceeds Number.MAX_SAFE_INTEGER/
    );
  });

  it('rejects out-of-range feature-family references in an otherwise valid rehashed scene', async () => {
    const packed = await packAnnotationSceneBinaryV1(input());
    const corruptPayload = packed.payload.slice();
    const view = new DataView(
      corruptPayload.buffer,
      corruptPayload.byteOffset,
      corruptPayload.byteLength
    );
    view.setUint32(packed.manifest.sections.featureFamilies.byteOffset, families.length, true);
    const rehashed = structuredClone(packed.manifest);
    rehashed.integrity.payloadSha256 = await sha256Hex(corruptPayload);
    await expect(validateAnnotationSceneBinaryV1(rehashed, corruptPayload)).rejects.toThrow(
      /featureFamilyIndices\[0\] is out of range/
    );
  });
});

const _manifestTypeGuard: AnnotationSceneBinaryManifestV1['schema'] = ANNOTATION_SCENE_BINARY_V1;
void _manifestTypeGuard;
