import type {
  ReferenceVerificationState,
  VerificationSession,
  VerificationTrack,
  SessionViewPreferences,
  Mutation,
  AlignmentData,
  StructuralAnalysis,
  TrackStatus,
  SessionMode,
  SessionAlignmentOperation,
} from '../types';
import { getAlignmentEvidence } from '../utils/mutation-computation';

export const SIDECAR_VERSION = '3.0' as const;
export const SIDECAR_EXTENSION = '.waypoint.json';

export interface AlignmentSidecar {
  type: 'alignment-history';
  version: typeof SIDECAR_VERSION | '2.0';
  reference: {
    name: string;
    checksum: string;
    documentId?: string;
  };
  savedAt: string;
  activeSessionId: string | null;
  sessions: SidecarSession[];
  viewPreferences: Record<string, SessionViewPreferences>;
}

interface SidecarSession {
  id: string;
  name: string;
  createdAt: string;
  mode: SessionMode;
  archived?: boolean;
  alignmentOperation?: SessionAlignmentOperation;
  alignmentPreparation?: VerificationSession['alignmentPreparation'];
  alignmentPreparedReference?: VerificationSession['alignmentPreparedReference'];
  tracks: SidecarTrack[];
  historicalTracks?: SidecarTrack[];
}

interface SidecarTrack {
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
  testedReference?: VerificationTrack['testedReference'];
  evidenceRunId?: string;
}

export function getAlignmentSidecarPath(referencePath: string): string {
  return `${referencePath}${SIDECAR_EXTENSION}`;
}

export function stateToSidecar(
  referenceName: string,
  refState: ReferenceVerificationState,
  viewPreferences: Record<string, SessionViewPreferences>,
  referenceChecksum: string
): AlignmentSidecar {
  const prefix = `${refState.documentId}::`;

  const relevantPrefs: Record<string, SessionViewPreferences> = {};
  for (const [key, prefs] of Object.entries(viewPreferences)) {
    if (key.startsWith(prefix)) {
      relevantPrefs[key.slice(prefix.length)] = prefs;
    }
  }

  return {
    type: 'alignment-history',
    version: SIDECAR_VERSION,
    reference: {
      name: referenceName,
      checksum: referenceChecksum,
      documentId: refState.documentId,
    },
    savedAt: new Date().toISOString(),
    activeSessionId: refState.activeSessionId,
    sessions: refState.sessions.map(sessionToSidecar),
    viewPreferences: relevantPrefs,
  };
}

function sessionToSidecar(session: VerificationSession): SidecarSession {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    mode: session.mode,
    archived: session.archived || undefined,
    alignmentOperation: session.alignmentOperation,
    alignmentPreparation: session.alignmentPreparation,
    alignmentPreparedReference: session.alignmentPreparedReference,
    tracks: session.tracks.map(trackToSidecar),
    historicalTracks: session.historicalTracks?.map(trackToSidecar),
  };
}

function trackToSidecar(track: VerificationTrack): SidecarTrack {
  return {
    id: track.id,
    queryPath: track.queryPath,
    queryFingerprint: track.queryFingerprint,
    label: track.label,
    alignment: track.alignment,
    mutations: track.mutations,
    structuralAnalysis: track.structuralAnalysis,
    status: track.status,
    userStatus: track.userStatus,
    userOverrideReason: track.userOverrideReason,
    alignedAt: track.alignedAt,
    checkedMutations:
      track.checkedMutations && track.checkedMutations.length > 0
        ? track.checkedMutations
        : undefined,
    testedReference: track.testedReference,
    evidenceRunId: track.evidenceRunId,
  };
}

export function sidecarToState(
  sidecar: AlignmentSidecar,
  documentId: string
): {
  refState: ReferenceVerificationState;
  viewPreferences: Record<string, SessionViewPreferences>;
  referenceChecksum: string;
} {
  const hydrateTrack = (t: SidecarTrack): VerificationTrack => ({
    id: t.id,
    queryPath: t.queryPath,
    queryFingerprint: t.queryFingerprint,
    label: t.label,
    alignment: t.alignment,
    mutations: t.mutations,
    structuralAnalysis: t.structuralAnalysis,
    status: getAlignmentEvidence(t.alignment.alignedReference, t.alignment.alignedQuery).complete
      ? t.status
      : 'incomplete',
    userStatus: t.userStatus,
    userOverrideReason: t.userOverrideReason,
    alignedAt: t.alignedAt,
    checkedMutations: t.checkedMutations,
    testedReference: t.testedReference,
    evidenceRunId: t.evidenceRunId,
  });
  const sessions: VerificationSession[] = sidecar.sessions.map((s) => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    mode: s.mode,
    archived: s.archived,
    alignmentOperation: s.alignmentOperation,
    alignmentPreparation: s.alignmentPreparation,
    alignmentPreparedReference: s.alignmentPreparedReference,
    tracks: s.tracks.map(hydrateTrack),
    historicalTracks: s.historicalTracks?.map(hydrateTrack),
  }));

  const viewPreferences: Record<string, SessionViewPreferences> = {};
  for (const [storedKey, preferences] of Object.entries(sidecar.viewPreferences)) {
    const separatorIndex = storedKey.lastIndexOf('::');
    const sessionId = separatorIndex >= 0 ? storedKey.slice(separatorIndex + 2) : storedKey;
    viewPreferences[`${documentId}::${sessionId}`] = preferences;
  }

  return {
    refState: {
      documentId,
      sessions,
      activeSessionId: sidecar.activeSessionId,
    },
    viewPreferences,
    referenceChecksum: sidecar.reference.checksum || '',
  };
}

export function isAlignmentSidecar(data: unknown): data is AlignmentSidecar {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.type === 'alignment-history' &&
    typeof obj.version === 'string' &&
    typeof obj.savedAt === 'string' &&
    typeof obj.reference === 'object' &&
    Array.isArray(obj.sessions)
  );
}

export function serializeSidecar(sidecar: AlignmentSidecar): string {
  return JSON.stringify(sidecar, null, 2);
}

export function parseSidecar(content: string): AlignmentSidecar {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid sidecar JSON: ${e instanceof Error ? e.message : 'parse error'}`);
  }
  if (!isAlignmentSidecar(data)) {
    throw new Error('Invalid sidecar: not an alignment-history file');
  }
  return data;
}
