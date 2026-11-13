import { defineGroup, invoke } from './contract';

export const dialogContract = defineGroup('dialog', {
  open: invoke<
    [
      options: {
        directory?: boolean;
        fileOrDirectory?: boolean;
        multiple?: boolean;
        title?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
      },
    ],
    string | string[] | null
  >(),
  authorizeLocalIndexedTrack: invoke<
    [request: import('../local-indexed-track-authority').LocalIndexedTrackAuthorityRequest],
    import('../local-indexed-track-authority').LocalIndexedTrackAuthorityReceipt
  >(),
  save: invoke<
    [
      options: {
        defaultPath?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
      },
    ],
    string | null
  >(),
});
