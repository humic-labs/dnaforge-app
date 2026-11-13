import type { ResidueSelection } from '@waypoint/workspace-editor';
import type { ResidueMeasurement } from '../../page/public/embeds/structure3d/residueMeasurement';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import type { StructureDrawerRequest } from '../types/structure-drawer';

export interface InspectionComparison {
  referenceId: string;
  alternateId: string;
  referenceSha256: string;
  alternateSha256: string;
  referenceChain?: string;
  alternateChain?: string;
}

export interface InspectionPredictionArtifact {
  resultReferenceId?: string;
  chainId?: string;
  jobRecordId: string;
  provider: string;
  remoteId: string;
  toolId: string;
  workspaceRoot: string;
  filePath: string;
  format: 'pdb' | 'cif';
  sha256: string;
  proteinSequenceSha256: string;
  metrics: Record<string, unknown>;
  provenance: Record<string, string>;
}

export type InspectionViewSettings = Pick<
  Structure3dAttrs,
  | 'view'
  | 'showSequenceViewer'
  | 'molViewSpec'
  | 'molViewSpecSnapshotIndex'
  | 'cameraSnapshot'
  | 'molecularData'
> & {
  candidateId?: string;

  structureViewId?: string;
};

export type RetainedProteinView = Pick<
  StructureInspection,
  | 'comparison'
  | 'attachedChainId'
  | 'candidateId'
  | 'viewSettings'
  | 'savedViewReferenceId'
  | 'measurements'
  | 'activeMeasurementId'
  | 'prediction'
  | 'catalogSource'
  | 'continuationReferenceId'
> &
  Partial<Pick<StructureInspection, 'request' | 'selections'>>;

export interface StructureInspection {
  request: StructureDrawerRequest;
  comparison?: InspectionComparison;
  attachedChainId?: string;
  continuationReferenceId?: string;
  prediction?: InspectionPredictionArtifact;
  catalogSource?: { observationId: string; chainKey: string };
  message?: string;
  candidateId?: string;
  selections?: ResidueSelection[];

  mutationCamera?: 'keep' | 'follow';

  focusSelectionId?: string;

  savedViewReferenceId?: string;
  measurements?: ResidueMeasurement[];
  activeMeasurementId?: string;
  viewSettings?: InspectionViewSettings;

  retainedProteinViews?: Record<string, RetainedProteinView>;
}
