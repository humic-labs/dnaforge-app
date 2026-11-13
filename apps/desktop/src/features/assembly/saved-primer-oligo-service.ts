import { resolveWorkspaceId } from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { resolveMocloFactoryWorkspaceRoot } from '../design/public/materialize-design-artifact';
import type { SavedOligoSnapshot } from '../design/public/saved-primer-links';
import { useDesignStore } from '../design/public/store';
import { describeAssemblyTmContext } from '../junction-workbench/public/settings';
import { primerServices } from '../primers/public/primer-services';
import { recordPrimers } from '../primers/public/record-primers';
import { savedOligoSnapshot } from '../primers/public/saved-oligo-snapshot';
import { assemblyPrimerAnnealing, assemblyPrimerArtifactStem } from './primer-artifacts';
import { createSavedPrimerOligoCommands } from './saved-primer-oligos';

async function readOligo(
  oligoId: string,
  workspaceRoot: string
): Promise<SavedOligoSnapshot | null> {
  const primer = await primerServices.persistence.getPrimer(oligoId);
  if (!primer) return null;
  try {
    const read = await primerServices.persistence.readArtifact(primer, workspaceRoot);
    return savedOligoSnapshot(read.artifact);
  } catch (error) {
    console.warn('[AssemblyPrimerOligos] A saved oligo could not be read:', oligoId, error);
    return null;
  }
}

const commands = createSavedPrimerOligoCommands({
  getDesign: (designId) => useDesignStore.getState().designs[designId],
  setSavedPrimerLinks: (designId, links) =>
    useDesignStore.getState().setSavedPrimerLinks(designId, links),
  resolveWorkspaceRoot: (design) =>
    resolveMocloFactoryWorkspaceRoot(
      design,
      Object.values(useDesignStore.getState().designs),
      useWorkspaceStore.getState().folders
    ),
  describeTm: (design) => describeAssemblyTmContext(design.pcrPolymerase),
  findOligosByBases: async (bases, workspaceRoot) => {
    const normalized = bases.trim().toUpperCase();
    const workspaceId = await resolveWorkspaceId(workspaceRoot);
    if (workspaceId == null || !normalized) return [];
    const rows = await primerServices.persistence.searchLegacyPrimers({ query: normalized });
    const snapshots: SavedOligoSnapshot[] = [];
    for (const row of rows) {
      if (row.workspaceId !== workspaceId || row.sequence.trim().toUpperCase() !== normalized)
        continue;
      const snapshot = await readOligo(row.id, workspaceRoot);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  },
  readOligo,
  saveOligo: async (primer, workspaceRoot) => {
    const result = await recordPrimers({
      primers: [
        {
          name: primer.name,
          sequence: primer.sequence,
          ...(primer.oligo ? { oligo: primer.oligo } : {}),
          annealing: assemblyPrimerAnnealing(primer),
          tm: primer.tm,
          application: 'pcr',
          artifactStem: await assemblyPrimerArtifactStem(primer),
        },
      ],
      workspaceRoot,
      origin: 'assembly',
    });
    const saved = result.recorded[0];
    if (!saved) {
      throw new Error(result.failed[0]?.message ?? `Primer ${primer.name} could not be saved.`);
    }
    return savedOligoSnapshot(saved.artifact);
  },
  restoreBindingSplit: async (oligo, bindingLength, workspaceRoot) => {
    const primer = await primerServices.persistence.getPrimer(oligo.oligoId);
    if (!primer) throw new Error(`Saved oligo ${oligo.catalogNumber} is unavailable.`);
    const read = await primerServices.persistence.readArtifact(primer, workspaceRoot);
    const bases = read.artifact.sequence.bases;
    const saved = await primerServices.persistence.updateArtifactContent({
      artifactPath: read.path,
      workspaceRoot,
      expectedArtifactRevision: read.artifact.artifactRevision,
      ...(read.acceptedRevision ? { acceptedRevision: read.acceptedRevision } : {}),
      name: read.artifact.name,
      sequence: bases,
      annealing: {
        pbsSequence: bases.slice(bases.length - bindingLength),
        overhangSequence: bases.slice(0, bases.length - bindingLength),
      },
    });
    return savedOligoSnapshot(saved.artifact);
  },
  now: () => new Date(),
});

export const {
  inspectAssemblyPrimerOligos,
  linkAssemblyPrimerOligos,
  reconcileAssemblyPrimerOligos,
} = commands;

export async function primerIdsWithCurrentSavedOligo(designId: string): Promise<Set<string>> {
  if (!useDesignStore.getState().designs[designId]?.savedPrimerLinks?.length) return new Set();
  try {
    const report = await inspectAssemblyPrimerOligos(designId);
    return new Set(
      (report?.primers ?? [])
        .filter((entry) => entry.status === 'linked')
        .map((entry) => entry.use.primerId)
    );
  } catch (error) {
    console.warn('[AssemblyPrimerOligos] Saved oligo links could not be read:', error);
    return new Set();
  }
}
