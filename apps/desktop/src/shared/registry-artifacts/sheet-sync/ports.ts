import type {
  ArtifactHistoryPort,
  ArtifactRegistryOperations,
  WorkspaceMutationRunner,
} from '../../artifact-operation-ports';
import type { PrimerTmCalculationV1 } from '../../primer-artifacts/primer-artifact';
import type { PrimerEntitySchemaSnapshot } from '../../primer-artifacts/types';
import type { createPrimerArtifactOwner } from '../../primer-artifacts/primer-artifact-owner';
import type {
  RecordablePrimer,
  RecordPrimersInput,
  RecordPrimersResult,
} from '../../primer-artifacts/record-primers-owner';
import type { createProteinArtifactOwner } from '../../protein-artifacts/protein-artifact-owner';
import type { createEntityArtifactOwner } from '../entity-artifact-owner';
import type { PersistImportSetOperation } from '../import-set-core';
import type { SheetSyncFiles, SheetSyncPersistence } from './persistence';
import type { SheetSyncSources, GoogleSheetsPort } from './sources';
import type { SheetSyncLocalState } from './local-state';
import type { SheetSyncArtifacts } from './artifacts';

type PrimerOwner = ReturnType<typeof createPrimerArtifactOwner>;
export type SheetSyncPrimerInput = RecordablePrimer & { tmCalculation?: PrimerTmCalculationV1 };
export interface SheetSyncArtifactPorts {
  fs: SheetSyncFiles;
  resolveWorkspaceId(root: string): Promise<number | null>;
  withRendererWorkspaceMutation: WorkspaceMutationRunner;
  queryLimsEntities: ArtifactRegistryOperations['queryLimsEntities'];
  recordPrimers(
    input: Omit<RecordPrimersInput, 'primers'> & { primers: SheetSyncPrimerInput[] }
  ): Promise<RecordPrimersResult>;
  readPrimerArtifactAtPath: PrimerOwner['readPrimerArtifactAtPath'];
  reconcilePrimerArtifact: PrimerOwner['reconcilePrimerArtifact'];
  updatePrimerArtifactContent: PrimerOwner['updatePrimerArtifactContent'];
  recordProtein: ReturnType<typeof createProteinArtifactOwner>['recordProtein'];
  recordEntityArtifact: ReturnType<typeof createEntityArtifactOwner>['recordEntityArtifact'];
  resolvePrimerSchema(kind: string): Promise<PrimerEntitySchemaSnapshot>;
  calculatePrimerTm(sequence: string): Promise<PrimerTmCalculationV1>;
  reconcileWorkspaceAfterFilesChanged(input: {
    workspaceRoot: string;
    mutationToken?: string;
    strict?: boolean;
    notifyGitStatus?: boolean;
  }): Promise<unknown>;
}
export type SheetSyncRuntimePorts = SheetSyncArtifactPorts &
  SheetSyncPersistence &
  SheetSyncLocalState &
  SheetSyncSources &
  SheetSyncArtifacts &
  ArtifactHistoryPort & {
    googleSheets: GoogleSheetsPort;
    newConnectionId(): string;
    publicationPaths(root: string, dirty: ReadonlyMap<string, unknown>): Promise<string[]>;
    updateLimsEntity: ArtifactRegistryOperations['updateLimsEntity'];
    persistImportSet: PersistImportSetOperation;
    gitHead(root: string, mutationToken?: string): Promise<string | null>;
    gitShowCommit(
      path: string,
      commit: string,
      root: string,
      mutationToken?: string
    ): Promise<string | null>;
  };
