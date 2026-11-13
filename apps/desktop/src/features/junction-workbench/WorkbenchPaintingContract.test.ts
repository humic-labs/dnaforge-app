import { describe, expect, it } from 'vitest';
import { makeMappingPoint } from './coord-mapping';
import type { JunctionWorkbenchRow } from './model';
import {
  buildProductOwnerPreviewSequence,
  colorForRowPosition,
  primersForRow,
  provenanceForRow,
} from './WorkbenchPaintingContract';

describe('WorkbenchPaintingContract', () => {
  it('derives product primer colors from registered part ownership', () => {
    const row = productRow();

    const primer = primersForRow(row)[0];

    expect(colorForRowPosition(row, 0)).toBe('#38bdf8');
    expect(colorForRowPosition(row, 3)).toBe('#34d399');
    expect(primer.overhangColor).toBe('#38bdf8');
    expect(primer.pbsColor).toBe('#34d399');
  });

  it('derives source primer colors from source/partner paint ownership', () => {
    const row = sourceRow();

    const primer = primersForRow(row)[0];

    expect(primer.pbsColor).toBe('#111111');
    expect(primer.overhangColor).toBe('#222222');
  });

  it('omits deprecated barcode-style source/product provenance lanes', () => {
    const row = sourceRow();

    const contract = provenanceForRow(row);

    expect(contract.borderColor).toBe('#111111');
    expect(contract.labelBackground).toContain('rgba(17, 17, 17, 0.18)');
    expect(contract.extraLanes).toEqual([]);
    expect(provenanceForRow(productRow()).extraLanes).toEqual([]);
  });

  it('builds product-owner preview in product coordinates with product annotations', () => {
    const product = {
      ...productRow(),
      sequence: 'ABxyCD',
      annotations: [
        {
          name: 'product-candidate',
          type: 'CDS',
          start: 1,
          end: 6,
          direction: 1,
          color: '#16a34a',
        },
      ],
      points: [
        makeMappingPoint('product-row', 0, -2, 0, 'valid'),
        makeMappingPoint('product-row', 1, -1, 1, 'valid'),
        makeMappingPoint('product-row', 2, 0, 2, 'generated-tail'),
        makeMappingPoint('product-row', 3, 1, 3, 'generated-tail'),
        makeMappingPoint('product-row', 4, 2, 4, 'valid'),
        makeMappingPoint('product-row', 5, 3, 5, 'valid'),
      ],
      spacerColumns: [2, 3],
      productOwners: ['left', 'left', 'spacer', 'spacer', 'right', 'right'],
    };
    const shiftedLeftSource = {
      ...sourceRow(),
      sequence: 'uvWXyz',
      annotations: [
        {
          name: 'source-cds',
          type: 'CDS',
          start: 1,
          end: 6,
          direction: 1,
          color: '#dc2626',
        },
      ],
      points: [
        makeMappingPoint('source-row', 0, -2, null, 'valid'),
        makeMappingPoint('source-row', 1, -1, null, 'valid'),
        makeMappingPoint('source-row', 2, 0, null, 'valid'),
        makeMappingPoint('source-row', 3, 1, null, 'valid'),
        makeMappingPoint('source-row', 4, 2, null, 'valid'),
        makeMappingPoint('source-row', 5, 3, null, 'valid'),
      ],
    };

    const preview = buildProductOwnerPreviewSequence({
      productRow: product,
      activeSourceRow: shiftedLeftSource,
      owner: 'left',
    });

    expect(preview?.sequence).toBe('uvxyCD');
    expect(preview?.length).toBe(product.sequence.length);
    expect(preview?.annotations.map((annotation) => annotation.name)).toEqual([
      'product-candidate',
    ]);
  });

  it('keeps drag preview annotations on the settled product layout until release', () => {
    const product = {
      ...productRow(),
      productDragPreview: {
        owner: 'left' as const,
        sequence: 'TTTT',
        annotations: [
          {
            name: 'repacked-preview-cds',
            type: 'CDS',
            start: 0,
            end: 3,
            direction: 1,
            color: '#dc2626',
          },
        ],
      },
      annotations: [
        {
          name: 'settled-product-cds',
          type: 'CDS',
          start: 1,
          end: 4,
          direction: 1,
          color: '#16a34a',
        },
      ],
    };

    const preview = buildProductOwnerPreviewSequence({
      productRow: product,
      activeSourceRow: sourceRow(),
      owner: 'left',
    });

    expect(preview?.sequence).toBe('TTTT');
    expect(preview?.annotations.map((annotation) => annotation.name)).toEqual([
      'repacked-preview-cds',
    ]);

    const settledLayoutPreview = buildProductOwnerPreviewSequence({
      productRow: product,
      activeSourceRow: sourceRow(),
      owner: 'left',
      annotationMode: 'settled',
    });

    expect(settledLayoutPreview?.sequence).toBe('TTTT');
    expect(settledLayoutPreview?.annotations.map((annotation) => annotation.name)).toEqual([
      'settled-product-cds',
    ]);
  });
});

function productRow(): JunctionWorkbenchRow {
  return {
    id: 'product-row',
    kind: 'product',
    label: 'Product',
    sequence: 'ACGT',
    coordinateStart: 0,
    anchorRowPosition: 2,
    annotations: [],
    points: [
      makeMappingPoint('product-row', 0, -2, 0, 'valid'),
      makeMappingPoint('product-row', 1, -1, 1, 'valid'),
      makeMappingPoint('product-row', 2, 0, 2, 'valid'),
      makeMappingPoint('product-row', 3, 1, 3, 'valid'),
    ],
    productOwners: ['left', 'left', 'right', 'right'],
    primers: [
      {
        id: 'primer',
        name: 'Primer',
        start: 0,
        end: 4,
        direction: 'forward',
        bases: 'ACGT',
        tm: 60,
        gc: 50,
        mismatches: [],
      },
    ],
    leftFragmentColor: '#38bdf8',
    rightFragmentColor: '#34d399',
  };
}

function sourceRow(): JunctionWorkbenchRow {
  return {
    id: 'source-row',
    kind: 'left-source',
    label: 'Source',
    sequence: 'ACGT',
    coordinateStart: 0,
    anchorRowPosition: 2,
    annotations: [],
    points: [
      makeMappingPoint('source-row', 0, -2, 0, 'valid'),
      makeMappingPoint('source-row', 1, -1, 1, 'valid'),
      makeMappingPoint('source-row', 2, 0, 2, 'valid'),
      makeMappingPoint('source-row', 3, 1, 3, 'valid'),
    ],
    visibleColumns: [0, 1, 2, 3],
    contributingColumns: [1, 2],
    mutedColumns: [0, 3],
    primers: [
      {
        id: 'primer',
        name: 'Primer',
        start: 0,
        end: 4,
        direction: 'forward',
        bases: 'ACGT',
        tm: 60,
        gc: 50,
        mismatches: [],
      },
    ],
    fragmentColor: '#111111',
    partnerFragmentColor: '#222222',
  };
}
