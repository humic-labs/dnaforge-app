import { describe, expect, it } from 'vitest';
import {
  ensureManagedGenBankAnnotationIds,
  insertManagedGenBankAnnotation,
  listManagedGenBankAnnotations,
  managedGenBankAnnotationValueDigest,
  removeManagedGenBankAnnotation,
  replaceManagedGenBankAnnotation,
} from './managed-genbank-annotations';

const BASES = Array.from({ length: 40 }, (_, index) => 'acgt'[index % 4]).join('');
const OTHER_BASES = BASES.slice(0, -1) + (BASES.at(-1) === 'a' ? 'c' : 'a');
const ID_ONE = '11111111-1111-4111-8111-111111111111';
const ID_TWO = '22222222-2222-4222-8222-222222222222';

function feature(input: {
  type?: string;
  location: string;
  name: string;
  id?: string;
  extra?: string;
}): string {
  return (
    `     ${(input.type ?? 'misc_feature').padEnd(16)}${input.location}\n` +
    `                     /label="${input.name}"\n` +
    (input.id ? `                     /dnaforge_ann_id="${input.id}"\n` : '') +
    (input.extra ?? '')
  );
}

function document(features: string[], bases = BASES, topology = 'linear'): string {
  return (
    `LOCUS       example ${bases.length} bp DNA ${topology}\n` +
    'DEFINITION  preserve this header exactly\n' +
    'FEATURES             Location/Qualifiers\n' +
    features.join('') +
    `ORIGIN\n        1 ${bases}\n//\n`
  );
}

describe('managed GenBank annotation identity and raw-block Restore', () => {
  it('pins exact qualifier bytes and a verified absence separately from ID and label', async () => {
    const original = document([
      feature({
        location: '2..4',
        name: 'same label',
        id: ID_ONE,
        extra: '                     /db_xref="record-one"\n',
      }),
    ]);
    const revised = document([
      feature({
        location: '2..4',
        name: 'same label',
        id: ID_ONE,
        extra: '                     /db_xref="record-two"\n',
      }),
    ]);
    const first = await managedGenBankAnnotationValueDigest(original, ID_ONE);
    const second = await managedGenBankAnnotationValueDigest(revised, ID_ONE);
    const absence = await managedGenBankAnnotationValueDigest(document([]), ID_ONE);
    expect(first.present).toBe(true);
    expect(first.valueSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.present).toBe(true);
    expect(second.valueSha256).not.toBe(first.valueSha256);
    expect(absence.present).toBe(false);
    expect(absence.valueSha256).not.toBe(first.valueSha256);
    expect(await managedGenBankAnnotationValueDigest(document([]), ID_ONE)).toEqual(absence);
  });

  it('adds stable IDs without rebuilding untouched GenBank bytes', () => {
    const first = feature({ location: '2..4', name: 'one' });
    const second = feature({ location: '10..12', name: 'two', id: ID_TWO });
    const original = document([first, second]);
    const assigned = ensureManagedGenBankAnnotationIds(original, () => ID_ONE);
    expect(assigned).toBe(
      original.replace(first, first + `                     /dnaforge_ann_id="${ID_ONE}"\n`)
    );
    expect(listManagedGenBankAnnotations(assigned)).toMatchObject([
      { id: ID_ONE, ordinals: [0], name: 'one' },
      { id: ID_TWO, ordinals: [1], name: 'two' },
    ]);
  });

  it('reuses both IDs on an exact lost-acknowledgement retry with duplicate feature bytes', () => {
    const identical = feature({ location: '2..4', name: 'same' });
    const capture = document([identical, identical]);
    const minted = [ID_ONE, ID_TWO];
    const saved = ensureManagedGenBankAnnotationIds(capture, () => minted.shift()!);
    expect(listManagedGenBankAnnotations(saved).map((item) => item.id)).toEqual([ID_ONE, ID_TWO]);
    expect(
      ensureManagedGenBankAnnotationIds(
        capture,
        () => {
          throw new Error('An exact retry must not mint a new identity.');
        },
        saved
      )
    ).toBe(saved);
    const reordered = document([
      feature({ location: '2..4', name: 'same' }),
      feature({ location: '10..12', name: 'different' }),
    ]);
    expect(() => ensureManagedGenBankAnnotationIds(reordered, () => ID_ONE, saved)).toThrow(
      /ambiguous|duplicate/i
    );
  });

  it('retains an ID across a renamed, moved feature and raw one-block replacement', () => {
    const currentBlock = feature({ location: '2..4', name: 'old', id: ID_ONE });
    const sourceBlock = feature({
      location: 'complement(<5..9)',
      name: 'new',
      id: ID_ONE,
      extra: '                     /db_xref="one"\n                     /db_xref="two"\n',
    });
    const unchanged = feature({ location: '15..17', name: 'untouched', id: ID_TWO });
    const current = document([currentBlock, unchanged]);
    const source = document([sourceBlock, unchanged]);
    const restored = replaceManagedGenBankAnnotation({
      currentContent: current,
      sourceContent: source,
      annotationId: ID_ONE,
      currentFrameId: 'frame-one',
      sourceFrameId: 'frame-one',
    });
    expect(restored).toBe(current.replace(currentBlock, sourceBlock));
    expect(listManagedGenBankAnnotations(restored)).toMatchObject([
      { id: ID_ONE, name: 'new' },
      { id: ID_TWO, name: 'untouched' },
    ]);
  });

  it('copies order and circular origin-wrapping locations without flattening them', () => {
    const old = feature({ location: '2..4', name: 'old', id: ID_ONE });
    for (const [location, topology] of [
      ['order(2..4,7..9)', 'linear'],
      ['complement(join(35..40,1..4))', 'circular'],
    ] as const) {
      const historical = feature({
        location,
        name: 'historical',
        id: ID_ONE,
        extra: '                     /db_xref="first"\n                     /db_xref="second"\n',
      });
      const current = document([old], BASES, topology);
      const source = document([historical], BASES, topology);
      expect(
        replaceManagedGenBankAnnotation({
          currentContent: current,
          sourceContent: source,
          annotationId: ID_ONE,
          currentFrameId: 'frame-one',
          sourceFrameId: 'frame-one',
        })
      ).toBe(current.replace(old, historical));
    }
  });

  it('assigns one logical ID to a provably merged split CDS and replaces its complete group', () => {
    const first = feature({ type: 'CDS', location: '2..4', name: 'split' });
    const second = feature({ type: 'CDS', location: '6..8', name: 'split' });
    const withIds = ensureManagedGenBankAnnotationIds(document([first, second]), () => ID_ONE);
    expect(listManagedGenBankAnnotations(withIds)).toMatchObject([
      { id: ID_ONE, ordinals: [0, 1], name: 'split' },
    ]);
    const currentBlock = feature({
      type: 'CDS',
      location: 'join(2..4,6..8)',
      name: 'split old',
      id: ID_ONE,
    });
    const current = document([currentBlock]);
    const restored = replaceManagedGenBankAnnotation({
      currentContent: current,
      sourceContent: withIds,
      annotationId: ID_ONE,
      currentFrameId: 'frame-one',
      sourceFrameId: 'frame-one',
    });
    expect(restored).toBe(
      current.replace(
        currentBlock,
        withIds.slice(withIds.indexOf('     CDS'), withIds.indexOf('ORIGIN'))
      )
    );
    expect(listManagedGenBankAnnotations(restored)[0].ordinals).toEqual([0, 1]);
    expect(
      removeManagedGenBankAnnotation({
        currentContent: restored,
        sourceContent: document([]),
        annotationId: ID_ONE,
        currentFrameId: 'frame-one',
        sourceFrameId: 'frame-one',
      })
    ).toBe(document([]));
  });

  it('refuses duplicate or invalid IDs and non-contiguous merged groups', () => {
    expect(() =>
      listManagedGenBankAnnotations(
        document([
          feature({ location: '2..4', name: 'one', id: ID_ONE }),
          feature({ location: '10..12', name: 'two', id: ID_ONE }),
        ])
      )
    ).toThrow(/duplicate|conflict/i);
    expect(() =>
      listManagedGenBankAnnotations(
        document([feature({ location: '2..4', name: 'one', id: 'bad-id' })])
      )
    ).toThrow(/invalid/i);
    expect(() =>
      ensureManagedGenBankAnnotationIds(
        document([
          feature({
            type: 'CDS',
            location: '2..4',
            name: 'split',
            extra: '                     /locus_tag="same"\n',
          }),
          feature({ location: '5..5', name: 'middle' }),
          feature({
            type: 'CDS',
            location: '6..8',
            name: 'split',
            extra: '                     /locus_tag="same"\n',
          }),
        ]),
        () => ID_ONE
      )
    ).toThrow(/non-contiguous/i);
  });

  it('refuses equal-length different DNA, topology, or declared frame', () => {
    const block = feature({ location: '2..4', name: 'one', id: ID_ONE });
    const current = document([block]);
    const input = {
      currentContent: current,
      sourceContent: document([block]),
      annotationId: ID_ONE,
      currentFrameId: 'frame-one',
      sourceFrameId: 'frame-one',
    };
    expect(() =>
      replaceManagedGenBankAnnotation({
        ...input,
        sourceContent: document([block], OTHER_BASES),
      })
    ).toThrow(/bases|DNA|frame/i);
    expect(() =>
      replaceManagedGenBankAnnotation({
        ...input,
        sourceContent: document([block], BASES, 'circular'),
      })
    ).toThrow(/topology|frame/i);
    expect(() =>
      replaceManagedGenBankAnnotation({
        ...input,
        sourceFrameId: 'rotated-frame',
      })
    ).toThrow(/frame/i);
    expect(() =>
      replaceManagedGenBankAnnotation({
        ...input,
        sourceContent: document([block]).replace('DNA linear', 'DNA unknown'),
      })
    ).toThrow(/GenBank record/i);
  });

  it('removes a historical annotation while retaining all other raw bytes', () => {
    const first = feature({ location: '2..4', name: 'one', id: ID_ONE });
    const second = feature({ location: '10..12', name: 'two', id: ID_TWO });
    const current = document([first, second]);
    expect(
      removeManagedGenBankAnnotation({
        currentContent: current,
        sourceContent: document([second]),
        annotationId: ID_ONE,
        currentFrameId: 'frame-one',
        sourceFrameId: 'frame-one',
      })
    ).toBe(document([second]));
    expect(() =>
      removeManagedGenBankAnnotation({
        currentContent: current,
        sourceContent: current,
        annotationId: ID_ONE,
        currentFrameId: 'frame-one',
        sourceFrameId: 'frame-one',
      })
    ).toThrow(/still contains/i);
  });

  it('inherits only a uniquely byte-identical prior ID after a renderer save', () => {
    const plain = feature({ location: '2..4', name: 'one' });
    const prior = document([feature({ location: '2..4', name: 'one', id: ID_ONE })]);
    expect(
      ensureManagedGenBankAnnotationIds(
        document([plain]),
        () => {
          throw new Error('mint should not be called');
        },
        prior
      )
    ).toBe(prior);
    const edited = document([feature({ location: '2..5', name: 'one' })]);
    expect(ensureManagedGenBankAnnotationIds(edited, () => ID_TWO, prior)).toContain(
      `/dnaforge_ann_id="${ID_TWO}"`
    );
    const twoTwins = document([
      feature({ location: '2..4', name: 'one', id: ID_ONE }),
      feature({ location: '2..4', name: 'one', id: ID_TWO }),
    ]);
    expect(() =>
      ensureManagedGenBankAnnotationIds(document([plain]), () => ID_ONE, twoTwins)
    ).toThrow(/ambiguous/i);
    const originWrap = 'complement(join(1..4,35..40))';
    const circularPrior = document(
      [feature({ type: 'CDS', location: originWrap, name: 'wrap', id: ID_ONE })],
      BASES,
      'circular'
    );
    const linearCandidate = document(
      [feature({ type: 'CDS', location: originWrap, name: 'wrap' })],
      BASES,
      'linear'
    );
    expect(
      ensureManagedGenBankAnnotationIds(linearCandidate, () => ID_TWO, circularPrior)
    ).toContain(`/dnaforge_ann_id="${ID_TWO}"`);
  });

  it('refuses exact-match inheritance when either side has an indistinguishable twin', () => {
    const plain = feature({ location: '2..4', name: 'same feature' });
    const taggedOne = feature({ location: '2..4', name: 'same feature', id: ID_ONE });
    const taggedTwo = feature({ location: '2..4', name: 'same feature', id: ID_TWO });
    expect(() =>
      ensureManagedGenBankAnnotationIds(
        document([plain]),
        () => ID_TWO,
        document([taggedOne, plain])
      )
    ).toThrow(/ambiguous/i);
    expect(() =>
      ensureManagedGenBankAnnotationIds(
        document([taggedTwo, plain]),
        () => ID_ONE,
        document([taggedOne])
      )
    ).toThrow(/ambiguous/i);
  });

  it('inserts a verified historical group only when absent from the exact frame', () => {
    const sourceBlock = feature({ location: '2..4', name: 'old feature', id: ID_ONE });
    const currentBlock = feature({ location: '12..14', name: 'other', id: ID_TWO });
    const source = document([sourceBlock]);
    const current = document([currentBlock]);
    const input = {
      currentContent: current,
      sourceContent: source,
      annotationId: ID_ONE,
      currentFrameId: 'frame-one',
      sourceFrameId: 'frame-one',
    };
    expect(insertManagedGenBankAnnotation(input)).toBe(document([currentBlock, sourceBlock]));
    expect(() =>
      insertManagedGenBankAnnotation({
        ...input,
        currentContent: document([currentBlock, sourceBlock]),
      })
    ).toThrow(/already|present/i);
    expect(() =>
      insertManagedGenBankAnnotation({
        ...input,
        sourceContent: document([sourceBlock], OTHER_BASES),
      })
    ).toThrow(/bases|DNA|frame/i);
    const noFeatures = document([]).replace('FEATURES             Location/Qualifiers\n', '');
    expect(insertManagedGenBankAnnotation({ ...input, currentContent: noFeatures })).toBe(
      document([sourceBlock])
    );
  });
});
