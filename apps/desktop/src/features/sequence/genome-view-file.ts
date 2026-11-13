import { platform } from '../../platform';
import { TRACK_VIEW_SUFFIX, trackViewIdSchema, type SavedTrackView } from '../../shared/track-view';
import {
  PORTABLE_GENOME_VIEW_FILE_SUFFIX,
  openPortableGenomeViewDocument,
  type PortableGenomeViewFile,
} from './portable-genome-view-file';

export type GenomeViewFile =
  | Readonly<{ kind: 'track-view'; saved: SavedTrackView }>
  | Readonly<{ kind: 'legacy-portable-view'; saved: PortableGenomeViewFile }>;

export async function chooseGenomeViewFile(): Promise<GenomeViewFile | null> {
  const selected = await platform().dialog.open({
    title: 'Open DNAForge genome view',
    filters: [
      {
        name: 'DNAForge genome views',
        extensions: ['dnaforge-track-view.json', 'dnaforge-genome-view.json'],
      },
    ],
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  return path ? readGenomeViewFile(path) : null;
}

export async function readGenomeViewFile(path: string): Promise<GenomeViewFile> {
  if (path.endsWith(TRACK_VIEW_SUFFIX) || trackViewIdSchema.safeParse(path).success) {
    return { kind: 'track-view', saved: await platform().trackViews.read(path) };
  }
  if (path.endsWith(PORTABLE_GENOME_VIEW_FILE_SUFFIX)) {
    return { kind: 'legacy-portable-view', saved: await openPortableGenomeViewDocument(path) };
  }
  throw new Error('Choose a DNAForge genome view file.');
}
