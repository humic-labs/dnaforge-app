import { describe, expect, it } from 'vitest';
import {
  CONTACT_MATRIX_SCHEMA,
  CONTACT_SOURCE_SCHEMA,
  contactCameraSchema,
  contactProjectionViewStateSchema,
  contactSourceDescriptorSchema,
  contactSourceDocumentSchema,
  projectContactSource,
  type ContactSourceDescriptor,
  type ContactSourceDocument,
} from './contact-source';

const source: ContactSourceDescriptor = {
  schema: CONTACT_SOURCE_SCHEMA,
  path: 'measurements/contact.json',
  sha256: 'a'.repeat(64),
  xReference: { id: 'assembly-a', chrom: 'chr1', length: 100 },
  yReference: { id: 'assembly-b', chrom: 'chr2', length: 200, label: 'Second axis' },
};
const document: ContactSourceDocument = {
  schema: CONTACT_MATRIX_SCHEMA,
  id: 'contact-1',
  label: 'Measured contacts',
  unit: 'counts',
  xReference: source.xReference,
  yReference: source.yReference,
  cells: [{ id: 'cell-1', start: 0, end: 10, targetStart: 20, targetEnd: 30, value: 4 }],
  colorScale: {
    kind: 'continuous',
    domain: [0, 10],
    colors: ['#000000', '#ffffff'],
    missingColor: '#cccccc',
    transform: 'linear',
  },
};

describe('contact source contract', () => {
  it('projects exact independent axes with a content-specific identity', () => {
    const projection = projectContactSource(contactSourceDocumentSchema.parse(document), source);
    expect(projection).toEqual({
      kind: 'contact-matrix',
      id: `contact-1:${source.sha256}`,
      xReference: source.xReference,
      yReference: source.yReference,
      cells: document.cells,
      colorScale: document.colorScale,
    });
  });

  it.each([
    '/contacts.json',
    '../contacts.json',
    'measurements/../contacts.json',
    'measurements/./contacts.json',
    'measurements//contacts.json',
    'C:/contacts.json',
    'measurements\\contacts.json',
    'contacts.json\u0000',
  ])('rejects non-relative or ambiguous paths: %s', (path) => {
    expect(contactSourceDescriptorSchema.safeParse({ ...source, path }).success).toBe(false);
  });

  it('requires an exact unprefixed SHA-256 and rejects unknown descriptor fields', () => {
    for (const sha256 of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${source.sha256}`]) {
      expect(contactSourceDescriptorSchema.safeParse({ ...source, sha256 }).success).toBe(false);
    }
    expect(contactSourceDescriptorSchema.safeParse({ ...source, data: document }).success).toBe(
      false
    );
  });

  it.each([
    { start: -1 },
    { start: 0.5 },
    { end: 0 },
    { end: 101 },
    { targetStart: 30 },
    { targetEnd: 201 },
    { value: -1 },
    { value: Infinity },
  ])('rejects invalid cells %j', (change) => {
    expect(
      contactSourceDocumentSchema.safeParse({
        ...document,
        cells: [{ ...document.cells[0], ...change }],
      }).success
    ).toBe(false);
  });

  it('rejects duplicate cell identities and undeclared document fields', () => {
    expect(
      contactSourceDocumentSchema.safeParse({
        ...document,
        cells: [document.cells[0], document.cells[0]],
      }).success
    ).toBe(false);
    expect(contactSourceDocumentSchema.safeParse({ ...document, camera: {} }).success).toBe(false);
  });

  it('requires valid color domains, hex colors, and positive values for log color', () => {
    const scale = document.colorScale;
    expect(
      contactSourceDocumentSchema.safeParse({
        ...document,
        colorScale: { ...scale, domain: [10, 0] },
      }).success
    ).toBe(false);
    expect(
      contactSourceDocumentSchema.safeParse({
        ...document,
        colorScale: { ...scale, missingColor: 'red' },
      }).success
    ).toBe(false);
    expect(
      contactSourceDocumentSchema.safeParse({
        ...document,
        cells: [{ ...document.cells[0], value: 0 }],
        colorScale: { ...scale, domain: [1, 10], transform: 'log10' },
      }).success
    ).toBe(false);
    expect(
      contactSourceDocumentSchema.safeParse({
        ...document,
        colorScale: { kind: 'categorical', colors: { '4': '#123456' }, missingColor: '#abcdef' },
      }).success
    ).toBe(true);
  });

  it('requires the exact chromosome, reference, length and optional label on each axis', () => {
    for (const change of [
      { id: 'other' },
      { chrom: 'other' },
      { length: 199 },
      { label: 'other' },
    ]) {
      expect(() =>
        projectContactSource(document, {
          ...source,
          yReference: { ...source.yReference, ...change },
        })
      ).toThrow('axis references');
    }
  });

  it('saves an admitted project reference and an independent bounded X/Y camera', () => {
    const camera = {
      projectionId: `contact-1:${source.sha256}`,
      xStart: 0.5,
      xEnd: 50,
      yStart: 20,
      yEnd: 80,
    };
    const view = { kind: 'contact-matrix', project: '/project', source, camera };
    expect(contactProjectionViewStateSchema.parse(view)).toEqual(view);
    expect(
      contactProjectionViewStateSchema.safeParse({ ...view, project: 'relative' }).success
    ).toBe(false);
    expect(
      contactProjectionViewStateSchema.safeParse({ ...view, camera: { ...camera, yEnd: 201 } })
        .success
    ).toBe(false);
    expect(contactCameraSchema.safeParse({ ...camera, xEnd: camera.xStart }).success).toBe(false);
    expect(contactCameraSchema.safeParse({ ...camera, yStart: NaN }).success).toBe(false);
  });
});
