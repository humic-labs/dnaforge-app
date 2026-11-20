import type { FileAssociationFamilyId } from '../shared/file-associations';
import type { FileOpenSourceSurface } from '../features/sequence/public/file-open-telemetry';
import { openExternalPreview } from './open-external-preview';

export function openQuickLookSource(input: {
  sourcePath: string;
  familyId: FileAssociationFamilyId;
  sourceSurface: FileOpenSourceSurface;
}): Promise<string | null> {
  return openExternalPreview(input.sourcePath, input.sourceSurface);
}
