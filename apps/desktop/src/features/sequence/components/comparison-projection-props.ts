import type { ComparisonCamera, ComparisonProjection } from '@waypoint/genome-renderer';

export interface ComparisonProjectionProps {
  comparisonProjection?: ComparisonProjection | null;
  comparisonCamera?: ComparisonCamera;
  onComparisonCameraChange?: (camera: ComparisonCamera, reason: 'scroll' | 'zoom') => void;
}
