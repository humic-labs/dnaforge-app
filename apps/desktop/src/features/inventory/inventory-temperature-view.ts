import type {
  InventoryStorageRequirementTarget,
  InventoryTemperatureAssessment,
  InventoryTemperatureFreshness,
  InventoryTemperatureRange,
  InventoryThermalContextValue,
} from '@waypoint/domain-services';
import type { InventoryItem } from './inventory-view';

export type InventoryTemperatureDialog =
  | { kind: 'temperature-requirement'; target: InventoryStorageRequirementTarget }
  | { kind: 'temperature-setpoint'; item: InventoryItem }
  | { kind: 'temperature-context'; item: InventoryItem }
  | {
      kind: 'temperature-claim';
      item: InventoryItem;
      assertion: 'specified-setpoint-range' | 'qualified-envelope';
    }
  | { kind: 'temperature-withdraw'; claimId: string };

export function isInventoryTemperatureDialog(dialog: {
  kind: string;
}): dialog is InventoryTemperatureDialog {
  return [
    'temperature-requirement',
    'temperature-setpoint',
    'temperature-context',
    'temperature-claim',
    'temperature-withdraw',
  ].includes(dialog.kind);
}

export function inventoryTemperatureRangeLabel(range: InventoryTemperatureRange): string {
  return `${range.minimum.value} to ${range.maximum.value} °C (inclusive)`;
}

export const inventoryTemperatureAssessmentLabels: Record<
  InventoryTemperatureAssessment['state'],
  string
> = {
  supported: 'Supported',
  incompatible: 'Incompatible',
  unknown: 'Unknown',
  conflicting: 'Conflicting evidence',
};

export const inventoryThermalRelationshipLabels: Record<
  InventoryThermalContextValue['kind'],
  string
> = {
  inherit: 'Inherit surrounding conditions',
  self: 'Has its own temperature control',
  unknown: 'Relationship unknown',
};

export function inventoryTemperatureReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    REPORT_NO_POLICY: 'No observation age policy selected',
    REPORT_TIME_UNKNOWN: 'Report observation time is unknown',
    REPORT_FUTURE_OBSERVATION: 'Report observation time is after this snapshot',
    REPORT_WITHIN_POLICY: 'Report is within the selected observation age policy',
    REPORT_EXCEEDS_POLICY: 'Report is older than the selected observation age policy',
    ENVIRONMENT_THERMAL_CONTEXT_UNKNOWN: 'The temperature relationship is unknown',
    ENVIRONMENT_NO_THERMAL_CONTEXT:
      'No item in the current location path has declared temperature control',
    'no-thermal-context': 'No item in the current location path has declared temperature control',
    'thermal-context-unknown': 'The temperature relationship is unknown',
  };
  if (labels[reason]) return labels[reason];
  return reason
    .toLowerCase()
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function inventoryTemperatureFreshnessLabel(
  freshness: InventoryTemperatureFreshness
): string {
  const labels: Record<InventoryTemperatureFreshness['reason'], string> = {
    'within-policy': 'Within selected age policy',
    'exceeds-policy': 'Older than selected age policy',
    'no-policy': 'Age policy not selected',
    'time-unknown': 'Observation time unknown',
    'future-observation': 'Observation time is after this snapshot',
  };
  return labels[freshness.reason];
}

export function inventoryObservationTime(kind: 'unknown' | 'known', text: string): number | null {
  if (kind === 'unknown') return null;
  const at = Date.parse(text);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    new Date(at).toISOString() !== text
  )
    throw new Error(
      'Enter a UTC observation time, for example 2026-11-16T12:00:00.000Z, or choose Unknown.'
    );
  return at;
}
