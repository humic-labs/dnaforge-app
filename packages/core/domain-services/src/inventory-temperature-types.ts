import type {
  InventoryExecutionContext,
  InventoryPhysicalItem,
  InventorySourceReference,
  InventoryGeometry,
  InventoryOrientation,
  InventoryLayout,
  InventoryVesselLimits,
  InventoryLocatedPlacement,
} from './inventory-types';

export const INVENTORY_TEMPERATURE_DECIMAL_PATTERN = '^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?$(?![\\s\\S])';
export interface InventoryTemperature {
  readonly value: string;
  readonly unit: 'C';
}
export interface InventoryTemperatureRange {
  readonly minimum: InventoryTemperature;
  readonly maximum: InventoryTemperature;
}
export type InventoryTemperatureKnowledge =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly temperature: InventoryTemperature };
export type InventoryTemperatureSubject =
  | { readonly kind: 'type-version'; readonly versionId: string }
  | {
      readonly kind: 'installed';
      readonly item: InventoryPhysicalItem;
      readonly configurationRevision: number;
    };
export type InventoryTemperatureAssertion =
  | { readonly kind: 'specified-setpoint-range'; readonly range: InventoryTemperatureRange }
  | {
      readonly kind: 'qualified-envelope';
      readonly scope?: 'physical-and-thermal-arrangement';
      readonly range: InventoryTemperatureRange;
      readonly atSetpoint: InventoryTemperature;
      readonly assumptions: string;
    };
interface InventoryTemperatureRecordedFact {
  readonly observedAt: number | null;
  readonly source: InventorySourceReference | null;
  readonly reason: string;
  readonly at: number;
  readonly by: InventoryExecutionContext['principal'];
}
export interface InventoryTemperatureClaim extends InventoryTemperatureRecordedFact {
  readonly id: string;
  readonly subject: InventoryTemperatureSubject;
  readonly assertion: InventoryTemperatureAssertion;
  readonly installation: readonly InventoryTemperatureInstallationEntry[] | null;
  readonly lifecycle:
    | { readonly kind: 'active' }
    | {
        readonly kind: 'withdrawn';
        readonly at: number;
        readonly by: InventoryExecutionContext['principal'];
        readonly reason: string;
      };
}
export interface InventoryTemperatureInstallationEntry {
  readonly item: InventoryPhysicalItem;
  readonly thermalRelationship: 'inherit' | 'self' | 'unknown' | null;
  readonly configurationRevision: number;
  readonly typeVersionId: string | null;
  readonly geometry: InventoryGeometry;
  readonly orientation: InventoryOrientation;
  readonly unavailablePositionIds: readonly string[];
  readonly layout: InventoryLayout | null;
  readonly limits: InventoryVesselLimits | null;
  readonly placement: { readonly kind: 'root' } | InventoryLocatedPlacement;
  readonly lifecycle: 'active' | 'disposed';
}
export interface InventoryEquipmentSetpoint extends InventoryTemperatureRecordedFact {
  readonly item: InventoryPhysicalItem;
  readonly value: InventoryTemperatureKnowledge;
}
export type InventoryThermalContextValue =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'self' }
  | { readonly kind: 'unknown' };
export interface InventoryThermalContext extends InventoryTemperatureRecordedFact {
  readonly item: InventoryPhysicalItem;
  readonly value: InventoryThermalContextValue;
}
export type InventoryStorageRequirementTarget =
  | { readonly kind: 'stock'; readonly id: string }
  | { readonly kind: 'lot'; readonly id: string };
export type InventoryStorageRequirementValue =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'specified'; readonly range: InventoryTemperatureRange };
export interface InventoryStorageRequirement extends InventoryTemperatureRecordedFact {
  readonly target: InventoryStorageRequirementTarget;
  readonly value: InventoryStorageRequirementValue;
}
export type InventoryTemperatureCommand =
  | {
      readonly kind: 'record-thermal-context';
      readonly item: InventoryPhysicalItem;
      readonly value: InventoryThermalContextValue;
      readonly observedAt: number | null;
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-temperature-claim';
      readonly id: string;
      readonly subject: InventoryTemperatureSubject;
      readonly assertion: InventoryTemperatureAssertion;
      readonly observedAt: number | null;
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'withdraw-temperature-claim';
      readonly claimId: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-equipment-setpoint';
      readonly item: InventoryPhysicalItem;
      readonly value: InventoryTemperatureKnowledge;
      readonly observedAt: number | null;
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    }
  | {
      readonly kind: 'record-storage-requirement';
      readonly target: InventoryStorageRequirementTarget;
      readonly value: InventoryStorageRequirementValue;
      readonly observedAt: number | null;
      readonly source: InventorySourceReference | null;
      readonly reason: string;
    };
export interface InventoryTemperatureFreshness {
  readonly state: 'fresh' | 'stale' | 'unknown';
  readonly observedAt: number | null;
  readonly ageMs: number | null;
  readonly reason:
    | 'within-policy'
    | 'exceeds-policy'
    | 'no-policy'
    | 'time-unknown'
    | 'future-observation';
}
export interface InventoryTemperatureAssessment {
  readonly state: 'supported' | 'incompatible' | 'unknown' | 'conflicting';
  readonly reasons: readonly string[];
  readonly claimIds: readonly string[];
}
export interface InventoryTemperatureClaimProjection {
  readonly claim: InventoryTemperatureClaim;
  readonly applicability:
    | 'applicable'
    | 'withdrawn'
    | 'configuration-changed'
    | 'setpoint-unknown'
    | 'setpoint-changed';
  readonly freshness: InventoryTemperatureFreshness;
}
export interface InventoryEquipmentTemperatureProjection {
  readonly item: InventoryPhysicalItem;
  readonly thermalContext: InventoryThermalContext | null;
  readonly setpoint: InventoryEquipmentSetpoint | null;
  readonly setpointFreshness: InventoryTemperatureFreshness;
  readonly claims: readonly InventoryTemperatureClaimProjection[];
}
export interface InventoryStockTemperatureProjection {
  readonly stockId: string;
  readonly requirement: {
    readonly value: Exclude<InventoryStorageRequirementValue, { readonly kind: 'inherit' }>;
    readonly setting: InventoryStorageRequirement | null;
    readonly inheritedFromLotId: string | null;
    readonly reason: 'stock-override' | 'lot-inheritance' | 'lot-unknown' | 'unattributed';
  };
  readonly environment:
    | { readonly kind: 'known'; readonly item: InventoryPhysicalItem }
    | {
        readonly kind: 'unknown';
        readonly reason:
          | 'custody-unavailable'
          | 'disposed'
          | 'no-thermal-context'
          | 'thermal-context-unknown';
      };
  readonly capability: InventoryTemperatureAssessment;
  readonly reportedTarget: InventoryTemperatureAssessment;
  readonly qualifiedSupport: InventoryTemperatureAssessment;
}
export interface InventoryStorageConditionsProjection {
  readonly asOf: number;
  readonly freshnessMaxAgeMs: number | null;
  readonly equipment: Readonly<Record<string, InventoryEquipmentTemperatureProjection>>;
  readonly stocks: Readonly<Record<string, InventoryStockTemperatureProjection>>;
}
