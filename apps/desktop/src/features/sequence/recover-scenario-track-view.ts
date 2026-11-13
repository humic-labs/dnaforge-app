import type { SavedTrackView } from '../../shared/track-view';
import { recoverScenarioTrackSource } from './recover-scenario-track-source';
import { saveTrackView } from './track-view-library';

export async function recoverScenarioTrackView(
  saved: SavedTrackView,
  signal?: AbortSignal
): Promise<SavedTrackView> {
  if (!saved.document.dataTracks.some((track) => track.source.provenance.devScenarioFixture))
    return saved;
  let recovered = false;
  const dataTracks: typeof saved.document.dataTracks = [];
  for (const track of saved.document.dataTracks) {
    const source = await recoverScenarioTrackSource(
      track.source,
      saved.document.reference.chromosomes.map(({ chrom, length }) => ({
        name: chrom,
        length,
      })),
      signal
    );
    dataTracks.push(source === track.source ? track : { ...track, source });
    recovered ||= source !== track.source;
  }
  if (!recovered) return saved;
  if (signal?.aborted) throw new DOMException('Track view recovery cancelled', 'AbortError');
  return (
    await saveTrackView({
      document: { ...saved.document, dataTracks, updatedAt: new Date().toISOString() },
      expectedRevision: saved.revision,
      destination: {
        path: saved.path,
        workspaceRoot: saved.workspaceRoot ?? saved.path.replace(/[\\/][^\\/]+$/, ''),
      },
    })
  ).saved;
}
