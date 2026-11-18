export type SessionMode = 'one-per-clone' | 'multi-per-clone';

export type TrackStatus = 'pass' | 'variants' | 'fail' | 'incomplete';

export type MutationType = 'substitution' | 'insertion' | 'deletion';

export type MutationEffect =
  | 'synonymous'
  | 'missense'
  | 'nonsense'
  | 'readthrough'
  | 'frameshift'
  | 'inframe_insertion'
  | 'inframe_deletion'
  | 'intergenic';

export type StructuralType =
  | 'deletion'
  | 'insertion'
  | 'truncation'
  | 'tandem_duplication'
  | 'dispersed_duplication'
  | 'inversion'
  | 'replacement'
  | 'chimera'
  | 'complex';

export interface StructuralRegion {
  id: string;
  type: StructuralType;
  confidence: number;
  severity: 'high' | 'medium' | 'low';
  columnStart: number;
  columnEnd: number;
  refStart: number | null;
  refEnd: number | null;
  lengthColumns: number;
  forwardIdentity: number;
  mutationIndices: number[];
  classificationMethod?: string;
  classificationDetails?: string;
}

export interface OverallAssessment {
  result: 'PASS' | 'FAIL' | 'REVIEW';
  reason: string;
}

export interface StructuralAnalysis {
  structuralRegions: StructuralRegion[];
  pointMutationIndices: number[];
  overallAssessment: OverallAssessment;
  warnings: Array<{
    type: string;
    message: string;
    severity: string;
  }>;
}

export interface Mutation {
  id: string;
  position: number;
  type: MutationType;
  referenceBase: string;
  alternateBase: string;
  length: number;

  effect?: {
    featureName: string;
    featureType: string;
    codonPosition?: number;
    aminoAcidChange?: string;
    classification: MutationEffect;
  };

  quality?: number;
}

export interface AggregatedMutation extends Mutation {
  trackIds: string[];
  hasConflict: boolean;
}

export interface AlignmentData {
  alignedReference: string;
  alignedQuery: string;
  circularOffset?: number;
  referenceLength?: number;
  identity: number;
  coverageStart: number;
  coverageEnd: number;
  algorithm: string;
}

export interface VerificationTrack {
  id: string;
  queryPath: string;
  queryFingerprint?: string;
  label: string;
  alignment: AlignmentData;
  mutations: Mutation[];
  structuralAnalysis?: StructuralAnalysis;
  status: TrackStatus;
  userStatus?: TrackStatus;
  userOverrideReason?: string;
  alignedAt: string;
  checkedMutations?: string[];
  failedToRealign?: boolean;
  testedReference?: {
    fileSha256: string;
    sequenceRevision: string;
    topology: 'linear' | 'circular';
    checkpointId: string | null;
  };
  evidenceRunId?: string;
}

export type SessionAlignmentOperationStatus =
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface SessionAlignmentOperationQuery {
  id: string;
  queryPath: string;
  label: string;
  queryFingerprint?: string;
}

export interface SessionAlignmentOperation {
  id: string;
  inputRevision: string;
  inputCorrelationId?: string;
  status: SessionAlignmentOperationStatus;
  queries: SessionAlignmentOperationQuery[];
  attachmentError?: string;
  testedReference?: NonNullable<VerificationTrack['testedReference']>;
  evidenceRunId?: string;
}

export interface VerificationSession {
  id: string;
  name: string;
  createdAt: string;
  mode: SessionMode;
  tracks: VerificationTrack[];
  historicalTracks?: VerificationTrack[];
  archived?: boolean;
  alignmentOperation?: SessionAlignmentOperation;
  alignmentPreparation?: SessionAlignmentOperationQuery[];
  alignmentPreparedReference?: {
    testedReference: NonNullable<VerificationTrack['testedReference']>;
    evidenceRunId?: string;
  };
}

export interface ReferenceVerificationState {
  documentId: string;
  sessions: VerificationSession[];
  activeSessionId: string | null;
}

export type MinimapViewMode = 'single' | 'stacked';

export interface SessionViewPreferences {
  viewMode: MinimapViewMode;
  selectedTrackId: string | null;
  alignmentVisible?: boolean;
  hiddenTrackIds?: string[];
}

export function getEffectiveStatus(track: VerificationTrack): TrackStatus {
  return track.userStatus ?? track.status;
}

export interface CoordinateProjection {
  refToAlignment(refPos: number): number;
  alignmentToRef(alignCol: number): number | null;
  getInsertions(): Array<{ afterRefPos: number; length: number }>;
  getDeletions(): Array<{ startRefPos: number; endRefPos: number }>;
}

export interface CreateSessionInput {
  name: string;
  mode: SessionMode;
  queryPaths: string[];
}

export interface FocusedPosition {
  documentId: string;
  position: number;
  timestamp: number;
}

export interface VerificationActions {
  createSession: (documentId: string, input: CreateSessionInput) => string;

  addTrackToSession: (documentId: string, sessionId: string, track: VerificationTrack) => void;

  updateTrack: (
    documentId: string,
    sessionId: string,
    trackId: string,
    updates: Partial<VerificationTrack>
  ) => void;

  setActiveSession: (documentId: string, sessionId: string | null) => void;

  removeSession: (documentId: string, sessionId: string) => Promise<void>;

  removeTrack: (documentId: string, sessionId: string, trackId: string) => void;

  getVerificationState: (documentId: string) => ReferenceVerificationState | undefined;

  getActiveSession: (documentId: string) => VerificationSession | undefined;

  setSessionViewPreferences: (
    documentId: string,
    sessionId: string,
    prefs: Partial<SessionViewPreferences>
  ) => void;

  getSessionViewPreferences: (
    documentId: string,
    sessionId: string
  ) => SessionViewPreferences | undefined;

  navigateToPosition: (documentId: string, position: number) => void;
}
