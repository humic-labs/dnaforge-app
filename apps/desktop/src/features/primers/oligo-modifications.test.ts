// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  IDT_CATALOG_SNAPSHOT,
  IDT_MODIFICATION_CATALOG,
  IDT_VENDOR_DEFINITION,
  displayIdtToken,
  insertIdtModification,
  idtModificationCategoryFilters,
  parseIdtOligoNotation,
  searchIdtModificationOptions,
  tokenizeIdtOligoNotation,
  resizeIdtOligoNotation,
} from './oligo-modifications';

describe('IDT oligo modification model', () => {
  it('removes orphaned linkages on shortening and keeps linkages to retained terminal bases', () => {
    expect(resizeIdtOligoNotation('ACGTACGTACG*T', 11)).toBe('ACGTACGTACG');
    expect(resizeIdtOligoNotation('ACG*T/3InvdT/', 4)).toBe('ACG*/3InvdT/');
    expect(parseIdtOligoNotation(resizeIdtOligoNotation('ACGTACGTACG*T', 11)).errors).toEqual([]);
  });

  it('resizes terminal and internal chemistry by biological base count', () => {
    const notation = '/5Phos/AC/iBiodT/G/3SpC3/';
    expect(resizeIdtOligoNotation(notation, 5, 'A')).toBe('/5Phos/AC/iBiodT/GA/3SpC3/');
    expect(resizeIdtOligoNotation(notation, 2)).toBe('/5Phos/AC/3SpC3/');
    expect(resizeIdtOligoNotation('/5Phos/AC/iSp18/GT/3SpC3/', 2)).toBe('/5Phos/AC/3SpC3/');
    expect(resizeIdtOligoNotation('AC/3InvdT/', 4, 'G')).toBe('ACG/3InvdT/');
    expect(resizeIdtOligoNotation('AC/3InvdT/', 2)).toBe('A/3InvdT/');
    expect(parseIdtOligoNotation(resizeIdtOligoNotation(notation, 2)).errors).toEqual([]);
    expect(() => resizeIdtOligoNotation('AC/unknown/', 2)).toThrow();
  });

  it('keeps vendor placement constraints on every catalog entry', () => {
    expect(IDT_CATALOG_SNAPSHOT.entries).toHaveLength(259);
    expect(IDT_MODIFICATION_CATALOG).toHaveLength(264);
    expect(new Set(IDT_MODIFICATION_CATALOG.map((entry) => entry.vendorCode)).size).toBe(264);
    expect(new Set(IDT_MODIFICATION_CATALOG.map((entry) => entry.notation)).size).toBe(264);
    expect(IDT_VENDOR_DEFINITION.catalogBrowseUrl).toBe(
      'https://www.idtdna.com/site/catalog/modifications'
    );
    expect(new Set(IDT_CATALOG_SNAPSHOT.entries.map((entry) => entry.vendorCode)).size).toBe(259);
    expect(
      IDT_CATALOG_SNAPSHOT.entries.filter((entry) => entry.placement === 'five-prime')
    ).toHaveLength(114);
    expect(
      IDT_CATALOG_SNAPSHOT.entries.filter((entry) => entry.placement === 'internal')
    ).toHaveLength(51);
    expect(
      IDT_CATALOG_SNAPSHOT.entries.filter((entry) => entry.placement === 'three-prime')
    ).toHaveLength(94);
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === '5Phos')).toMatchObject({
      placement: 'five-prime',
      behavior: 'terminal-attachment',
    });
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === 'iSp18')).toMatchObject({
      placement: 'internal',
      behavior: 'between-bases',
    });
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === '3InvdT')).toMatchObject({
      placement: 'three-prime',
      behavior: 'modified-base',
      naturalBase: 'T',
    });
    expect(
      IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === 'iSuper-dG')
    ).toMatchObject({
      placement: 'internal',
      behavior: 'modified-base',
      naturalBase: 'G',
    });
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === 'iRiboI')).toMatchObject({
      behavior: 'modified-base',
      naturalBase: 'N',
    });
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === 'iBHQ-1dT')).toMatchObject(
      {
        category: 'quencher',
        behavior: 'modified-base',
        naturalBase: 'T',
      }
    );
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === '3Puro')).toMatchObject({
      placement: 'three-prime',
      behavior: 'terminal-attachment',
    });
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === 'ZEN')).toMatchObject({
      label: 'ZEN',
      category: 'other',
    });
    expect(IDT_MODIFICATION_CATALOG.find((entry) => entry.vendorCode === '+A')).toMatchObject({
      label: 'Affinity Plus A',
      notation: '+A',
      category: 'modified-base',
      behavior: 'modified-base',
      naturalBase: 'A',
      allowedPlacements: ['five-prime', 'internal', 'three-prime'],
    });
    expect(idtModificationCategoryFilters('dna')).toEqual(
      expect.arrayContaining([
        { label: 'Modified Bases', count: 68 },
        { label: 'Phosphorothioate Bonds', count: 1 },
        { label: 'Click Chemistry', count: 10 },
      ])
    );
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '', { orderType: 'dna' })
    ).toHaveLength(260);
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '', { orderType: 'rna' })
    ).toHaveLength(248);
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '55HydMe-dC', {
        orderType: 'dna',
      }).map((entry) => entry.vendorCode)
    ).toContain('55HydMe-dC');
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '55HydMe-dC', {
        orderType: 'rna',
      })
    ).toEqual([]);
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '5IRD700', {
        orderType: 'dna',
      }).map((entry) => entry.vendorCode)
    ).toContain('5IRD700');
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '5IRD700', {
        orderType: 'rna',
      })
    ).toEqual([]);
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, 'i2FU', {
        orderType: 'dna',
      }).map((entry) => entry.vendorCode)
    ).toContain('i2FU');
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, 'i2FU', {
        orderType: 'rna',
      }).map((entry) => entry.vendorCode)
    ).toContain('i2FU');
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, 'ZEN', { orderType: 'dna' })
    ).toEqual([]);
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, 'ZEN', { orderType: 'rna' })
    ).toEqual([]);
    expect(
      searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '', {
        categoryLabel: 'Click Chemistry',
      }).map((entry) => entry.vendorCode)
    ).toEqual(
      expect.arrayContaining(['5Hexynyl', '5AzideN', 'iAzideN', '3AzideN', '5DBCOTEG', '3DBCON'])
    );
  });

  it('distinguishes recognized but order-type-incompatible codes from unknown codes', () => {
    const incompatible = parseIdtOligoNotation('/55HydMe-dC/rArC', { orderType: 'rna' });
    expect(incompatible.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'incompatible-order-type',
          vendorCode: '55HydMe-dC',
          severity: 'error',
        }),
      ])
    );
    expect(incompatible.errors[0]).toMatch(/not available for IDT RNA oligos/i);
    expect(incompatible.composition).toBeNull();

    expect(
      parseIdtOligoNotation('/DefinitelyUnknown/rArC', { orderType: 'rna' }).diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unknown-modification', vendorCode: 'DefinitelyUnknown' }),
      ])
    );
  });

  it('keeps lowercase DNA IUPAC ambiguity codes separate from RNA-only prefixes', () => {
    for (const suffix of ['a', 'c', 'g', 't', 'A', 'C', 'G', 'T']) {
      const notation = `m${suffix}`;
      const parsed = parseIdtOligoNotation(notation, { orderType: 'dna' });

      expect(parsed.errors, notation).toEqual([]);
      expect(parsed.bases, notation).toBe(notation);
      expect(tokenizeIdtOligoNotation(notation, { orderType: 'dna' })).toMatchObject([
        { kind: 'degenerate-base', text: 'm', naturalBaseIndex: 0 },
        { kind: 'base', text: suffix, naturalBaseIndex: 1 },
      ]);
    }

    expect(parseIdtOligoNotation('mG', { orderType: 'rna' }).bases).toBe('G');
    expect(tokenizeIdtOligoNotation('mG', { orderType: 'rna' })).toMatchObject([
      { kind: 'two-prime-o-methyl-base', text: 'mG', naturalBaseIndex: 0 },
    ]);
  });

  it('marks bare T and U according to the selected oligo polymer', () => {
    expect(tokenizeIdtOligoNotation('TU', { orderType: 'dna' })).toMatchObject([
      { kind: 'base', text: 'T', naturalBaseIndex: 0 },
      { kind: 'invalid', text: 'U', naturalBaseIndex: 1 },
    ]);
    expect(parseIdtOligoNotation('TU', { orderType: 'dna' }).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-base',
          rawStart: 1,
          rawEnd: 2,
        }),
      ])
    );

    expect(tokenizeIdtOligoNotation('UT', { orderType: 'rna' })).toMatchObject([
      { kind: 'rna-base', text: 'U', naturalBaseIndex: 0 },
      { kind: 'alternate-polymer-base', text: 'T', naturalBaseIndex: 1 },
    ]);
    expect(parseIdtOligoNotation('UT', { orderType: 'rna' }).errors).toEqual([]);
  });

  it('gives every official code complete, saveable parser semantics', () => {
    for (const entry of IDT_MODIFICATION_CATALOG) {
      const token = displayIdtToken(entry.vendorCode);
      const notation =
        entry.vendorCode === '5rApp'
          ? `${token}AC/3SpC3/`
          : entry.behavior === 'linkage'
            ? 'A*C'
            : entry.placement === 'five-prime'
              ? `${token}AC`
              : entry.placement === 'three-prime'
                ? `AC${token}`
                : `A${token}C`;
      const parsed = parseIdtOligoNotation(notation, {
        enforceOrderTypeAvailability: false,
      });
      expect(parsed.errors, `${entry.vendorCode}: ${notation}`).toEqual([]);
      expect(parsed.composition?.modifications[0]?.vendorCode).toBe(entry.vendorCode);
      if (entry.behavior === 'modified-base') expect(entry.naturalBase).toBeDefined();
    }
  });

  it('maps every official catalog entry to its exact IDT product page', () => {
    const official = IDT_MODIFICATION_CATALOG.filter((entry) => entry.vendorMetadata);
    expect(official).toHaveLength(259);
    for (const entry of official) {
      expect(entry.productUrl, entry.vendorCode).toBe(
        `https://www.idtdna.com/site/Catalog/Modifications/Product/${entry.vendorMetadata?.productId}`
      );
    }
  });

  it('parses natural binding bases separately from terminal, internal, base, and bond modifications', () => {
    const parsed = parseIdtOligoNotation('/5Phos/ACG/iBiodT//iSp18/G/3InvdT/');

    expect(parsed.errors).toEqual([]);
    expect(parsed.bases).toBe('ACGTGT');
    expect(parsed.composition?.vendor).toBe('idt');
    expect(parsed.composition?.notation).toBe('/5Phos/ACG/iBiodT//iSp18/G/3InvdT/');
    expect(parsed.composition?.modifications).toEqual([
      expect.objectContaining({
        vendorCode: '5Phos',
        anchor: { kind: 'terminus', end: 'five-prime' },
      }),
      expect.objectContaining({
        vendorCode: 'iBiodT',
        naturalBase: 'T',
        anchor: { kind: 'base', index: 3 },
      }),
      expect.objectContaining({
        vendorCode: 'iSp18',
        anchor: { kind: 'between-bases', offset: 4 },
      }),
      expect.objectContaining({
        vendorCode: '3InvdT',
        naturalBase: 'T',
        anchor: { kind: 'base', index: 5 },
      }),
    ]);

    const phosphorothioate = parseIdtOligoNotation('A*C*G*T');
    expect(phosphorothioate.errors).toEqual([]);
    expect(phosphorothioate.bases).toBe('ACGT');
    expect(phosphorothioate.composition?.modifications).toEqual([
      expect.objectContaining({ vendorCode: '*', anchor: { kind: 'between-bases', offset: 1 } }),
      expect.objectContaining({ vendorCode: '*', anchor: { kind: 'between-bases', offset: 2 } }),
      expect.objectContaining({ vendorCode: '*', anchor: { kind: 'between-bases', offset: 3 } }),
    ]);
  });

  it('rejects a valid IDT code when it is used at an invalid position', () => {
    expect(parseIdtOligoNotation('ACGT/5Phos/').errors[0]).toMatch(/5′ end/);
    expect(parseIdtOligoNotation('/3Phos/ACGT').errors[0]).toMatch(/3′ end/);
    expect(parseIdtOligoNotation('/iSp18/ACGT').errors[0]).toMatch(/between two bases/);
    expect(parseIdtOligoNotation('ACGT/iSp18/').errors[0]).toMatch(/between two bases/);
    expect(parseIdtOligoNotation('A*').errors[0]).toMatch(/between two bases/);
  });

  it('reports the exact source span and evidence for an invalidly placed modification', () => {
    const parsed = parseIdtOligoNotation('A/5BiodT/CG');

    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: 'invalid-placement',
        severity: 'error',
        vendorCode: '5BiodT',
        rawStart: 1,
        rawEnd: 9,
        sourceUrl: 'https://www.idtdna.com/site/Catalog/Modifications/Product/1606',
      }),
    ]);
    expect(parsed.errors).toEqual(['/5BiodT/ can only be used at the 5′ end.']);
    expect(parsed.composition).toBeNull();
  });

  it('records documented adjacency guidance without inventing a hard DTPA maximum', () => {
    const documentedSeries = parseIdtOligoNotation('A/iDTPA//iDTPA//iDTPA/T');
    const largerSeries = parseIdtOligoNotation('A/iDTPA//iDTPA//iDTPA//iDTPA/T');

    expect(documentedSeries.errors).toEqual([]);
    expect(largerSeries.errors).toEqual([]);
    expect(largerSeries.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'vendor-constraint',
          severity: 'warning',
          ruleId: 'idt-dtpa-documented-adjacent-series',
          vendorCode: 'iDTPA',
        }),
      ])
    );
    expect(IDT_VENDOR_DEFINITION.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'idt-dtpa-documented-adjacent-series',
          kind: 'documented-adjacent-series',
          enforcement: 'informational',
          minimumDocumented: 2,
          maximumDocumented: 3,
          sourceUrl:
            'https://www.idtdna.com/page/support-and-education/decoded-plus/choosing-the-right-mod-for-your-needs/',
        }),
        expect.objectContaining({
          id: 'idt-terminal-biotin-spacer18-max-consecutive',
          kind: 'contextual-max-consecutive',
          enforcement: 'hard',
          maximum: 3,
          appliesWhen: expect.objectContaining({ adjacentChemistryId: 'biotin-teg' }),
        }),
      ])
    );

    expect(parseIdtOligoNotation('A*C*G*T').errors).toEqual([]);
    expect(parseIdtOligoNotation('A/iSpC3//iSpC3/G').errors).toEqual([]);
  });

  it('parses Affinity Plus notation and enforces product-specific total limits', () => {
    expect(parseIdtOligoNotation('+A+C+G+T')).toMatchObject({
      bases: 'ACGT',
      errors: [],
      composition: {
        modifications: [
          expect.objectContaining({ vendorCode: '+A', placement: 'five-prime' }),
          expect.objectContaining({ vendorCode: '+C', placement: 'internal' }),
          expect.objectContaining({ vendorCode: '+G', placement: 'internal' }),
          expect.objectContaining({ vendorCode: '+T', placement: 'three-prime' }),
        ],
      },
    });

    const sevenAffinityBases = '+A'.repeat(7);
    expect(parseIdtOligoNotation(sevenAffinityBases).errors).toEqual([]);
    expect(
      parseIdtOligoNotation(sevenAffinityBases, { productClass: 'qpcr-probe' }).diagnostics
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          ruleId: 'idt-affinity-plus-qpcr-max-total',
          rawStart: 12,
          rawEnd: 14,
        }),
      ])
    );
    expect(parseIdtOligoNotation('+A'.repeat(20)).errors).toEqual([]);
    expect(parseIdtOligoNotation('+A'.repeat(21)).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          ruleId: 'idt-affinity-plus-oligo-max-total',
          rawStart: 40,
          rawEnd: 42,
        }),
      ])
    );
  });

  it('parses exact IDT RNA, 2-prime-O-methyl, and DNA-RNA chimera notation', () => {
    const rna = parseIdtOligoNotation('rArCrGrU', { orderType: 'rna' });
    expect(rna).toMatchObject({
      bases: 'ACGU',
      errors: [],
      composition: {
        vendor: 'idt',
        orderType: 'rna',
        notation: 'rArCrGrU',
        modifications: [],
      },
    });

    const methylated = parseIdtOligoNotation('mAmCmGmU', { orderType: 'rna' });
    expect(methylated).toMatchObject({
      bases: 'ACGU',
      errors: [],
      composition: { orderType: 'rna', notation: 'mAmCmGmU' },
    });

    expect(parseIdtOligoNotation('ArCrGTrU', { orderType: 'rna' })).toMatchObject({
      bases: 'ACGTU',
      errors: [],
    });
  });

  it('keeps RNA base families source-ranged without stealing DNA ambiguity prefixes', () => {
    expect(
      tokenizeIdtOligoNotation('rAmC/5Phos/rG', { orderType: 'rna' }).map((run) => ({
        kind: run.kind,
        text: run.text,
        rawStart: run.rawStart,
        rawEnd: run.rawEnd,
        naturalBaseIndex: run.naturalBaseIndex,
      }))
    ).toEqual([
      { kind: 'rna-base', text: 'rA', rawStart: 0, rawEnd: 2, naturalBaseIndex: 0 },
      {
        kind: 'two-prime-o-methyl-base',
        text: 'mC',
        rawStart: 2,
        rawEnd: 4,
        naturalBaseIndex: 1,
      },
      {
        kind: 'modification',
        text: '/5Phos/',
        rawStart: 4,
        rawEnd: 11,
        naturalBaseIndex: undefined,
      },
      { kind: 'rna-base', text: 'rG', rawStart: 11, rawEnd: 13, naturalBaseIndex: 2 },
    ]);

    expect(parseIdtOligoNotation('rArU')).toMatchObject({
      bases: 'rArU',
      diagnostics: [expect.objectContaining({ code: 'invalid-base', rawStart: 3, rawEnd: 4 })],
    });
    expect(tokenizeIdtOligoNotation('rArU', { orderType: 'dna' })).toMatchObject([
      { kind: 'degenerate-base', text: 'r' },
      { kind: 'base', text: 'A' },
      { kind: 'degenerate-base', text: 'r' },
      { kind: 'invalid', text: 'U' },
    ]);
  });

  it('keeps slash, Affinity Plus, and phosphorothioate modifications valid in RNA orders', () => {
    const parsed = parseIdtOligoNotation('/5Phos/rA*rC/iSp18/+GmU/3SpC3/', {
      orderType: 'rna',
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.bases).toBe('ACGU');
    expect(parsed.composition).toMatchObject({
      orderType: 'rna',
      notation: '/5Phos/rA*rC/iSp18/+GmU/3SpC3/',
      modifications: [
        expect.objectContaining({ vendorCode: '5Phos' }),
        expect.objectContaining({ vendorCode: '*' }),
        expect.objectContaining({ vendorCode: 'iSp18' }),
        expect.objectContaining({ vendorCode: '+G' }),
        expect.objectContaining({ vendorCode: '3SpC3' }),
      ],
    });
  });

  it('projects U-bearing modified bases by oligo type without rewriting true T chemistries', () => {
    const dnaFluoroU = parseIdtOligoNotation('A/i2FU/C', { orderType: 'dna' });
    const rnaFluoroU = parseIdtOligoNotation('rA/i2FU/rC', { orderType: 'rna' });
    const rnaDeoxyU = parseIdtOligoNotation('rA/ideoxyU/rC', { orderType: 'rna' });
    const rnaAffinityPlusT = parseIdtOligoNotation('rA+TrC', { orderType: 'rna' });

    expect(dnaFluoroU).toMatchObject({
      bases: 'ATC',
      errors: [],
      composition: {
        notation: 'A/i2FU/C',
        modifications: [expect.objectContaining({ vendorCode: 'i2FU', naturalBase: 'T' })],
      },
    });
    expect(rnaFluoroU).toMatchObject({
      bases: 'AUC',
      errors: [],
      composition: {
        orderType: 'rna',
        notation: 'rA/i2FU/rC',
        modifications: [expect.objectContaining({ vendorCode: 'i2FU', naturalBase: 'U' })],
      },
    });
    expect(rnaDeoxyU).toMatchObject({
      bases: 'AUC',
      errors: [],
      composition: {
        modifications: [expect.objectContaining({ vendorCode: 'ideoxyU', naturalBase: 'U' })],
      },
    });
    expect(rnaAffinityPlusT).toMatchObject({
      bases: 'ATC',
      errors: [],
      composition: {
        modifications: [expect.objectContaining({ vendorCode: '+T', naturalBase: 'T' })],
      },
    });
  });

  it('OR-combines selected categories and positions, then intersects the two filters', () => {
    const matches = searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '', {
      categoryLabels: ['Modified Bases', 'Click Chemistry'],
      placements: ['five-prime', 'three-prime'],
    });
    const codes = matches.map((entry) => entry.vendorCode);

    expect(codes).toContain('+A');
    expect(codes).toContain('5AzideN');
    expect(codes).toContain('3AzideN');
    expect(codes).not.toContain('iAzideN');
    expect(codes).not.toContain('5Phos');
    expect(
      matches.every(
        (entry) =>
          entry.allowedPlacements?.some((placement) =>
            ['five-prime', 'three-prime'].includes(placement)
          ) ?? ['five-prime', 'three-prime'].includes(entry.placement)
      )
    ).toBe(true);
  });

  it('blocks universal IDT incompatibility and required-companion violations', () => {
    const incompatible = parseIdtOligoNotation('/5YakYel/AC/36-TAMSp/');
    expect(incompatible.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          ruleId: 'idt-yakima-yellow-tamra-incompatible',
          vendorCode: '36-TAMSp',
        }),
      ])
    );
    expect(incompatible.composition).toBeNull();
    expect(
      parseIdtOligoNotation('/5YakYel/AC/36-TAMSp/', {
        enforceVendorConstraints: false,
      }).composition
    ).not.toBeNull();
    expect(
      parseIdtOligoNotation('A/5BiodT/CG', { enforceVendorConstraints: false }).errors
    ).toEqual(['/5BiodT/ can only be used at the 5′ end.']);

    expect(parseIdtOligoNotation('/5rApp/AC').diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          ruleId: 'idt-adenylation-requires-three-prime-block',
          vendorCode: '5rApp',
        }),
      ])
    );
    expect(parseIdtOligoNotation('/5rApp/AC/3SpC3/').errors).toEqual([]);
    expect(parseIdtOligoNotation('/5rApp/AC/3ddC/').errors).toEqual([]);
  });

  it('limits only Spacer 18 units that are actually between terminal Biotin-TEG and bases', () => {
    const tooManyAtFivePrime = parseIdtOligoNotation('/5BiotinTEG//5Sp18//5Sp18//5Sp18//5Sp18/AC');
    expect(tooManyAtFivePrime.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          ruleId: 'idt-terminal-biotin-spacer18-max-consecutive',
          vendorCode: '5Sp18',
        }),
      ])
    );
    expect(parseIdtOligoNotation('/5BiotinTEG//5Sp18//5Sp18//5Sp18/AC').errors).toEqual([]);
    expect(parseIdtOligoNotation('AC/3Sp18//3Sp18//3Sp18//3BioTEG/').errors).toEqual([]);
    expect(parseIdtOligoNotation('AC/3Sp18//3Sp18//3Sp18//3Sp18//3BioTEG/').diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          ruleId: 'idt-terminal-biotin-spacer18-max-consecutive',
          vendorCode: '3Sp18',
        }),
      ])
    );

    expect(parseIdtOligoNotation('/5Sp18//5Sp18//5Sp18//5Sp18//5BiotinTEG/AC').errors).toEqual([]);
  });

  it('does not accept unknown slash tokens or infer a natural base from their spelling', () => {
    const parsed = parseIdtOligoNotation('AC/DefinitelyLooksLikeT/G');
    expect(parsed.bases).toBe('ACG');
    expect(parsed.composition).toBeNull();
    expect(parsed.errors).toEqual(['Unknown IDT modification /DefinitelyLooksLikeT/.']);
  });

  it('allows a temporarily invalid insertion while keeping final notation validation strict', () => {
    expect(insertIdtModification('AC/', 2, 3, 'iSp18')).toEqual({
      notation: 'AC/iSp18/',
      caret: 9,
    });
    expect(parseIdtOligoNotation('AC/iSp18/').errors[0]).toMatch(/between two bases/);
    expect(parseIdtOligoNotation('AC/iSp18/G').errors).toEqual([]);
  });

  it('replaces the slash query and consumes a matching natural base for modified-base tokens', () => {
    expect(insertIdtModification('AC/ibT', 2, 5, 'iBiodT')).toEqual({
      notation: 'AC/iBiodT/',
      caret: 10,
    });
    expect(insertIdtModification('AC/ibT', 2, 5, 'iBiodT', { consumeFollowingBase: true })).toEqual(
      {
        notation: 'AC/iBiodT/',
        caret: 10,
      }
    );
    expect(insertIdtModification('AC/ib/TG', 2, 6, 'iBiodT')).toEqual({
      notation: 'AC/iBiodT/G',
      caret: 10,
    });
  });

  it('consumes the matching prefixed RNA base when inserting a modified base', () => {
    expect(insertIdtModification('AC/rUrG', 2, 3, 'i2FU', { orderType: 'rna' })).toEqual({
      notation: 'AC/i2FU/rG',
      caret: 8,
    });
    expect(insertIdtModification('AC/mUrG', 2, 3, 'i2FU', { orderType: 'rna' })).toEqual({
      notation: 'AC/i2FU/rG',
      caret: 8,
    });
    expect(insertIdtModification('AC/rUrG', 2, 3, 'iBiodT', { orderType: 'rna' })).toEqual({
      notation: 'AC/iBiodT/rUrG',
      caret: 10,
    });
  });

  it('tokenizes exact editable widths while preserving biological base indices', () => {
    const runs = tokenizeIdtOligoNotation('/5Phos/AR/iBiodT/G*Y');

    expect(
      runs.map((run) => ({
        kind: run.kind,
        text: run.text,
        rawStart: run.rawStart,
        rawEnd: run.rawEnd,
        naturalBaseIndex: run.naturalBaseIndex,
      }))
    ).toEqual([
      {
        kind: 'modification',
        text: '/5Phos/',
        rawStart: 0,
        rawEnd: 7,
        naturalBaseIndex: undefined,
      },
      { kind: 'base', text: 'A', rawStart: 7, rawEnd: 8, naturalBaseIndex: 0 },
      { kind: 'degenerate-base', text: 'R', rawStart: 8, rawEnd: 9, naturalBaseIndex: 1 },
      { kind: 'modification', text: '/iBiodT/', rawStart: 9, rawEnd: 17, naturalBaseIndex: 2 },
      { kind: 'base', text: 'G', rawStart: 17, rawEnd: 18, naturalBaseIndex: 3 },
      { kind: 'modification', text: '*', rawStart: 18, rawEnd: 19, naturalBaseIndex: undefined },
      { kind: 'degenerate-base', text: 'Y', rawStart: 19, rawEnd: 20, naturalBaseIndex: 4 },
    ]);
    expect(runs.map((run) => run.text).join('')).toBe('/5Phos/AR/iBiodT/G*Y');
  });

  it('keeps unfinished and unknown slash tokens visible as invalid display runs', () => {
    expect(tokenizeIdtOligoNotation('AC/unknown/GT').map((run) => [run.kind, run.text])).toEqual([
      ['base', 'A'],
      ['base', 'C'],
      ['invalid', '/unknown/'],
      ['base', 'G'],
      ['base', 'T'],
    ]);
    expect(tokenizeIdtOligoNotation('AC/unfinished').at(-1)).toMatchObject({
      kind: 'invalid',
      text: '/unfinished',
      rawStart: 2,
      rawEnd: 13,
    });
  });
});
