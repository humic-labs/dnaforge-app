// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { useTranslationDialogStore } from './translation-dialog-store';

describe('useTranslationDialogStore', () => {
  beforeEach(() => {
    useTranslationDialogStore.setState({ request: null });
  });

  it('starts closed', () => {
    expect(useTranslationDialogStore.getState().request).toBeNull();
  });

  it('open() sets the request; close() clears it', () => {
    useTranslationDialogStore.getState().open({ sequence: 'ATGAAA', label: '6 bp selected' });
    expect(useTranslationDialogStore.getState().request).toEqual({
      sequence: 'ATGAAA',
      label: '6 bp selected',
    });

    useTranslationDialogStore.getState().close();
    expect(useTranslationDialogStore.getState().request).toBeNull();
  });
});
