import type { ContactCamera, ContactProjection } from '@waypoint/genome-renderer';

export interface ContactProjectionProps {
  contactProjection?: ContactProjection | null;
  contactCamera?: ContactCamera;
  contactUnit?: string;
  onContactCameraChange?: (camera: ContactCamera, reason: 'scroll' | 'zoom') => void;
}
