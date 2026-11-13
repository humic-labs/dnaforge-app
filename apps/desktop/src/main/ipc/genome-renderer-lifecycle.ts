import { RendererOwnerLifecycle } from '../renderer-owner-lifecycle';

export type ReleaseGenomeRendererOwners = (webContentsId: number) => void;

export class GenomeRendererLifecycle extends RendererOwnerLifecycle {
  constructor(releaseOwners: ReleaseGenomeRendererOwners) {
    super(
      (sender) => releaseOwners(sender.id),
      () => {
        const error = new Error('[genome] Renderer closed during owner admission.');
        error.name = 'AbortError';
        return error;
      }
    );
  }
}
