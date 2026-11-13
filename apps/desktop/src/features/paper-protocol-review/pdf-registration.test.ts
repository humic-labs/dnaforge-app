import { beforeEach, describe, expect, it } from 'vitest';
import { usePaperProtocolReviewStore as store } from './store';
describe('PDF registration generation ownership', () => {
  beforeEach(() => store.setState({ pdfs: {}, pdfInstances: {} }));
  it('does not let old cleanup remove a newer exact-byte registration', () => {
    const older = {
      filePath: '/controlled.pdf',
      generationId: 'old',
      sha256: 'a'.repeat(64),
      pageCount: 2,
    };
    const newer = { ...older, generationId: 'new', sha256: 'b'.repeat(64) };
    store.getState().registerPdf(older);
    store.getState().registerPdf(newer);
    store.getState().unregisterPdf(older.filePath, older.generationId);
    expect(store.getState().pdfs[older.filePath]).toEqual(newer);
  });
  it('retains a still-mounted earlier view when the newest instance closes', () => {
    const older = {
      filePath: '/controlled.pdf',
      generationId: 'old',
      sha256: 'a'.repeat(64),
      pageCount: 2,
    };
    store.getState().registerPdf(older);
    store.getState().registerPdf({ ...older, generationId: 'new' });
    store.getState().unregisterPdf(older.filePath, 'new');
    expect(store.getState().pdfs[older.filePath]).toEqual(older);
    store.getState().unregisterPdf(older.filePath, 'old');
    expect(store.getState().pdfs).toEqual({});
  });
});
