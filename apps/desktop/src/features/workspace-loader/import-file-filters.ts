import { MANAGED_DNA_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';

export const WORKSPACE_IMPORT_FILE_FILTERS: Array<{ name: string; extensions: string[] }> = [
  { name: 'All files', extensions: ['*'] },
];

export const DNA_SEQUENCE_IMPORT_FILE_FILTERS: Array<{ name: string; extensions: string[] }> = [
  {
    name: 'DNA sequences',
    extensions: [...MANAGED_DNA_FILE_EXTENSIONS],
  },
];
