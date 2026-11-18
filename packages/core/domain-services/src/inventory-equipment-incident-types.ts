import type {
  InventoryCommand,
  InventoryCustody,
  InventoryCustodyDestination,
  InventoryExecutionContext,
  InventoryLayout,
  InventoryLocationObservation,
  InventoryLocationPathEntry,
  InventoryPhysicalItem,
  InventoryPlacement,
  InventoryPrincipal,
  InventoryRecordedPrincipal,
  InventoryState,
  InventoryStock,
  InventoryLot,
  InventoryStoragePlacement,
  InventoryAuthority,
  InventoryErrorCode,
} from './inventory-types';
import type { InventoryTableSha256, InventoryTableTarget } from './inventory-table-types';
import type { InventoryVesselContents } from './inventory-contents-types';
import type {
  InventoryTemperature,
  InventoryTemperatureFreshness,
} from './inventory-temperature-types';

export interface InventoryEquipmentIncidentActionIdentity {
  readonly namespace: string;
  readonly actionId: string;
}
export interface InventoryEquipmentIncidentPin {
  readonly incidentId: string;
  readonly intentSha256: InventoryTableSha256;
}
export interface InventoryEquipmentIncidentFactPin {
  readonly factId: string;
  readonly intentSha256: InventoryTableSha256;
}
export interface InventoryEquipmentIncidentReviewRootPin {
  readonly rootId: string;
  readonly intentSha256: InventoryTableSha256;
}
export type InventoryEquipmentIncidentReviewDisposition =
  | 'keep-incident-restriction'
  | 'remove-incident-restriction';
export type InventoryEquipmentIncidentAction =
  | {
      readonly kind: 'report';
      readonly equipment: { readonly storageId: string; readonly configurationRevision: number };
      readonly noticedAt: number | null;
      readonly description: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'manual-temperature';
      readonly incident: InventoryEquipmentIncidentPin;
      readonly reading:
        | {
            readonly kind: 'measured';
            readonly temperature: InventoryTemperature;
            readonly observedAt: number;
            readonly pointLabel: string;
          }
        | { readonly kind: 'withdrawn' };
      readonly supersedes: InventoryEquipmentIncidentFactPin | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'completed-relocation';
      readonly incident: InventoryEquipmentIncidentPin;
      readonly moves: readonly {
        readonly item: InventoryPhysicalItem;
        readonly destination: InventoryCustodyDestination;
      }[];
      readonly corrects: InventoryEquipmentIncidentFactPin | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'impact-review';
      readonly incident: InventoryEquipmentIncidentPin;
      readonly subjects: readonly {
        readonly root: InventoryEquipmentIncidentReviewRootPin;
        readonly supersedes: InventoryEquipmentIncidentFactPin | null;
      }[];
      readonly disposition: InventoryEquipmentIncidentReviewDisposition;
      readonly basis: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'resolve';
      readonly incident: InventoryEquipmentIncidentPin;
      readonly resolution: 'reported-resolved' | 'reported-in-error';
      readonly reason: string;
    };
export interface InventoryEquipmentIncidentActionChoices {
  readonly identity: InventoryEquipmentIncidentActionIdentity;
  readonly action: InventoryEquipmentIncidentAction;
}
export interface InventoryEquipmentIncidentActionProof {
  readonly actionId: string;
  readonly intentSha256: InventoryTableSha256;
  readonly choices: InventoryEquipmentIncidentActionChoices;
  readonly originalOwner: { readonly projectId: string; readonly inventoryId: string };
}
export interface InventoryEquipmentIncidentHolderSnapshot {
  readonly item: InventoryPhysicalItem;
  readonly name: string;
  readonly placement: InventoryPlacement;
  readonly custody: InventoryCustody;
  readonly lastKnown: InventoryLocationObservation | null;
  readonly currentPath: readonly InventoryLocationPathEntry[] | null;
}
export interface InventoryEquipmentIncidentVesselSnapshot extends InventoryEquipmentIncidentHolderSnapshot {
  readonly vesselKind: 'movable' | 'fixed-well';
  readonly contents: InventoryVesselContents;
}
export interface InventoryEquipmentIncidentEquipmentSnapshot {
  readonly id: string;
  readonly name: string;
  readonly configurationRevision: number;
  readonly typeVersionId: string | null;
  readonly layout: InventoryLayout;
  readonly placement: InventoryStoragePlacement;
}
export interface InventoryEquipmentIncident extends InventoryEquipmentIncidentActionProof {
  readonly id: string;
  readonly binding: { readonly storageId: string };
  readonly equipment: InventoryEquipmentIncidentEquipmentSnapshot;
  readonly initial: {
    readonly holders: readonly InventoryEquipmentIncidentHolderSnapshot[];
    readonly vessels: readonly InventoryEquipmentIncidentVesselSnapshot[];
    readonly reviewRootIds: readonly string[];
  };
  readonly contentsWhenRecorded: number;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryEquipmentIncidentReviewRoot {
  readonly id: string;
  readonly incident: InventoryEquipmentIncidentPin;
  readonly intentSha256: InventoryTableSha256;
  readonly originalOwner: InventoryEquipmentIncidentActionProof['originalOwner'];
  readonly originSubject:
    | { readonly kind: 'stock'; readonly stockId: string }
    | { readonly kind: 'contents-episode'; readonly vesselId: string; readonly episode: number };
  readonly originRevision: number;
  readonly origin: 'initial-cohort' | 'later-knowledge-observation';
  readonly qualification:
    | 'identified-stock-at-recording'
    | 'confirmed-unidentified-at-open'
    | 'possible-unconfirmed';
  readonly binding:
    | { readonly kind: 'stock'; readonly stockId: string }
    | { readonly kind: 'contents-episode'; readonly vesselId: string };
  readonly snapshot:
    | {
        readonly kind: 'stock';
        readonly vessel: InventoryEquipmentIncidentVesselSnapshot;
        readonly before: InventoryStock;
      }
    | {
        readonly kind: 'contents-episode';
        readonly vessel: InventoryEquipmentIncidentVesselSnapshot;
      };
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryEquipmentIncidentConfigurationBasis {
  readonly storageId: string;
  readonly configurationRevision: number;
  readonly typeVersionId: string | null;
  readonly thermalContext: { readonly kind: 'inherit' | 'self' | 'unknown' } | null;
}
export interface InventoryEquipmentIncidentRelocationEffect {
  readonly item: InventoryPhysicalItem;
  readonly before: InventoryEquipmentIncidentHolderSnapshot;
  readonly after: InventoryEquipmentIncidentHolderSnapshot;
  readonly descendantVesselIds: readonly string[];
  readonly descendantStockIds: readonly string[];
  readonly reviewRootIds: readonly string[];
}
export interface InventoryEquipmentIncidentOperatorFact extends InventoryEquipmentIncidentActionProof {
  readonly id: string;
  readonly kind: Exclude<InventoryEquipmentIncidentAction['kind'], 'report'>;
  readonly incident: InventoryEquipmentIncidentPin;
  readonly effects:
    | {
        readonly kind: 'manual-temperature';
        readonly configurationBasisAtRecording: InventoryEquipmentIncidentConfigurationBasis;
      }
    | {
        readonly kind: 'completed-relocation';
        readonly commands: readonly InventoryCommand[];
        readonly holders: readonly InventoryEquipmentIncidentRelocationEffect[];
      }
    | { readonly kind: 'impact-review' }
    | { readonly kind: 'resolve' };
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryEquipmentIncidentContentsFact {
  readonly id: string;
  readonly kind: 'contents-identified' | 'contents-episode-closed';
  readonly incident: InventoryEquipmentIncidentPin;
  readonly root: InventoryEquipmentIncidentReviewRootPin;
  readonly originalTransition: {
    readonly inventoryRevision: number;
    readonly vesselId: string;
    readonly stockId: string | null;
    readonly reason: string;
  };
  readonly binding: { readonly vesselId: string; readonly stockId: string | null };
  readonly intentSha256: InventoryTableSha256;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export type InventoryEquipmentIncidentFact =
  | InventoryEquipmentIncidentOperatorFact
  | InventoryEquipmentIncidentContentsFact;
export interface InventoryEquipmentIncidentEffectCounts {
  readonly capturedHolders: number;
  readonly capturedVessels: number;
  readonly createdReviewRoots: number;
  readonly identifiedContentsBridges: number;
  readonly relocatedHolders: number;
  readonly reviewedRoots: number;
}
export interface InventoryEquipmentIncidentCurrentStatus {
  readonly lifecycle: 'open' | 'resolved';
  readonly resolution: InventoryEquipmentIncidentFactPin | null;
  readonly review: {
    readonly pending: number;
    readonly kept: number;
    readonly removed: number;
    readonly importedRemovalUnconfirmed: number;
  };
}
export interface InventoryEquipmentIncidentActionSummary {
  readonly kind: InventoryEquipmentIncidentAction['kind'];
  readonly actionProof: InventoryEquipmentIncidentActionProof;
  readonly incident: InventoryEquipmentIncidentPin;
  readonly effectCounts: InventoryEquipmentIncidentEffectCounts;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryEquipmentIncidentSummary {
  readonly id: string;
  readonly actionProof: InventoryEquipmentIncidentActionProof;
  readonly equipment: InventoryEquipmentIncidentEquipmentSnapshot;
  readonly binding: { readonly storageId: string };
  readonly contentsWhenRecorded: number;
  readonly effectCounts: InventoryEquipmentIncidentEffectCounts;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
}
export interface InventoryEquipmentIncidentIssue {
  readonly code: InventoryErrorCode;
  readonly pointer: string;
  readonly message: string;
}
export interface InventoryEquipmentIncidentActionPreviewFacts {
  readonly schema: 'dnaforge.inventory-equipment-incident-action-preview.v1';
  readonly target: InventoryTableTarget;
  readonly actionId: string | null;
  readonly intentSha256: InventoryTableSha256 | null;
  readonly incidentId: string | null;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly nextBoundaryAt: number | null;
}
export type InventoryEquipmentIncidentActionPreview = InventoryEquipmentIncidentActionPreviewFacts &
  (
    | {
        readonly kind: 'ready';
        readonly record: InventoryEquipmentIncidentActionSummary;
        readonly effectCounts: InventoryEquipmentIncidentEffectCounts;
        readonly commands: readonly InventoryCommand[];
        readonly planDigest: InventoryTableSha256;
      }
    | {
        readonly kind: 'no-change';
        readonly record: InventoryEquipmentIncidentActionSummary;
        readonly current: InventoryEquipmentIncidentCurrentStatus;
        readonly commands: readonly [];
        readonly planDigest: null;
      }
    | {
        readonly kind: 'blocked';
        readonly record: null;
        readonly commands: readonly [];
        readonly planDigest: null;
        readonly issues: readonly [
          InventoryEquipmentIncidentIssue,
          ...InventoryEquipmentIncidentIssue[],
        ];
      }
  );
export interface InventoryEquipmentIncidentActionPreviewInput extends InventoryEquipmentIncidentActionChoices {
  readonly target: InventoryTableTarget;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly authority: InventoryAuthority;
}
export interface InventoryEquipmentIncidentActionApplication extends InventoryEquipmentIncidentActionChoices {
  readonly target: InventoryTableTarget;
  readonly expectedPlanDigest: InventoryTableSha256;
}
export type InventoryEquipmentIncidentActionExisting =
  | { readonly kind: 'new' }
  | {
      readonly kind: 'no-change';
      readonly record: InventoryEquipmentIncidentActionSummary;
      readonly current: InventoryEquipmentIncidentCurrentStatus;
    }
  | { readonly kind: 'blocked'; readonly issue: InventoryEquipmentIncidentIssue };
export interface InventoryEquipmentIncidentRootReview {
  readonly status: 'pending' | 'reviewed';
  readonly head: InventoryEquipmentIncidentFactPin | null;
  readonly disposition: InventoryEquipmentIncidentReviewDisposition | null;
  readonly restriction: 'pending' | 'kept' | 'removed' | 'imported-removal-unconfirmed';
}
export type InventoryEquipmentIncidentSubjectProjection =
  | {
      readonly view: 'initial';
      readonly key: string;
      readonly kind: 'holder';
      readonly snapshot: InventoryEquipmentIncidentHolderSnapshot;
      readonly reviewRootIds: readonly string[];
    }
  | {
      readonly view: 'initial';
      readonly key: string;
      readonly kind: 'vessel';
      readonly snapshot: InventoryEquipmentIncidentVesselSnapshot;
      readonly stock: InventoryStock | null;
      readonly reviewRootIds: readonly string[];
    }
  | {
      readonly view: 'current';
      readonly key: string;
      readonly kind: 'holder';
      readonly snapshot: InventoryEquipmentIncidentHolderSnapshot;
      readonly reviewRootIds: readonly string[];
    }
  | {
      readonly view: 'current';
      readonly key: string;
      readonly kind: 'vessel';
      readonly snapshot: InventoryEquipmentIncidentVesselSnapshot;
      readonly stock: InventoryStock | null;
      readonly reviewRootIds: readonly string[];
    }
  | {
      readonly view: 'review';
      readonly key: string;
      readonly kind: 'root';
      readonly root: InventoryEquipmentIncidentReviewRoot;
      readonly review: InventoryEquipmentIncidentRootReview;
    }
  | {
      readonly view: 'review';
      readonly key: string;
      readonly kind: 'stock';
      readonly stock: InventoryStock;
      readonly reviewRootIds: readonly string[];
      readonly relation: 'direct-subject' | 'derived-material';
    }
  | {
      readonly view: 'review';
      readonly key: string;
      readonly kind: 'lot';
      readonly lot: InventoryLot;
      readonly reviewRootIds: readonly string[];
    };
export interface InventoryEquipmentIncidentFactSummary {
  readonly id: string;
  readonly kind: InventoryEquipmentIncidentFact['kind'];
  readonly intentSha256: InventoryTableSha256;
  readonly incident: InventoryEquipmentIncidentPin;
  readonly at: number;
  readonly by: InventoryRecordedPrincipal;
  readonly actionProof: InventoryEquipmentIncidentActionProof | null;
}
export interface InventoryEquipmentIncidentManualFactProjection {
  readonly fact: InventoryEquipmentIncidentOperatorFact;
  readonly configurationApplicability:
    | 'same-recorded-configuration'
    | 'configuration-changed'
    | 'equipment-unavailable';
  readonly freshness: InventoryTemperatureFreshness;
  readonly asOf: number;
  readonly maxAgeMs: number | null;
}
export type InventoryEquipmentIncidentState = Pick<
  InventoryState,
  | 'equipmentIncidents'
  | 'equipmentIncidentReviewRoots'
  | 'equipmentIncidentFacts'
  | 'stocks'
  | 'lots'
  | 'storage'
  | 'vessels'
  | 'reservations'
  | 'lastRecordedAt'
>;
export type InventoryEquipmentIncidentExecutionContext = InventoryExecutionContext;
