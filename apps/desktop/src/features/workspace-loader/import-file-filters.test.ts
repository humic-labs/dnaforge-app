import { expect, it } from 'vitest';
import { MANAGED_DNA_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';
import {
  DNA_SEQUENCE_IMPORT_FILE_FILTERS,
  WORKSPACE_IMPORT_FILE_FILTERS,
} from './public/import-file-filters';

it('general workspace import allows every document type in its default native filter', () => {
  expect(WORKSPACE_IMPORT_FILE_FILTERS[0]).toEqual({ name: 'All files', extensions: ['*'] });
});

it('DNA-specific import retains the supported managed sequence formats without a wildcard', () => {
  expect(DNA_SEQUENCE_IMPORT_FILE_FILTERS).toEqual([
    { name: 'DNA sequences', extensions: [...MANAGED_DNA_FILE_EXTENSIONS] },
  ]);
  expect(DNA_SEQUENCE_IMPORT_FILE_FILTERS.flatMap((filter) => filter.extensions)).not.toContain(
    '*'
  );
  expect(DNA_SEQUENCE_IMPORT_FILE_FILTERS.flatMap((filter) => filter.extensions)).not.toContain(
    'pdf'
  );
});
