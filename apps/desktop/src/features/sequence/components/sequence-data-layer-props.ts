import type { SupplementalLinearTrack } from '@waypoint/genome-renderer';
import type { SequenceDataLayerTrackControls } from '../data-layers/useSequenceDataLayers';

export interface SequenceDataLayerProjectionProps {
  dataLayerTracks?: readonly SupplementalLinearTrack[];
  dataLayerControls?: SequenceDataLayerTrackControls;
  annotationColorsByIdentity?: ReadonlyMap<string, string>;
  missingAnnotationColor?: string;
}
