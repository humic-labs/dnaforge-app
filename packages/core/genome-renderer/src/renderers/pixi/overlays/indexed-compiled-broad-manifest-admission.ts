import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '../shared/annotation-runtime-theme';

export function canAdmitCompiledBroadSurfaceManifest(input: {
  hasManifestObject: boolean;
  hostGenomeLength: number;
  manifestGenomeLength: number;
  hasAdmittedSurface: boolean;
  requirement: {
    genomeLengthBp: number;
    broadCorridorFinestSpanBp: number;
  } | null;
  manifestBroadCorridorFinestSpanBp: number;
  themeMode: string;
  provenanceFailure: string | null;
}): boolean {
  if (!input.hasManifestObject) return false;
  if (input.hostGenomeLength > 0 && input.manifestGenomeLength !== input.hostGenomeLength) {
    return false;
  }
  if (
    input.hasAdmittedSurface &&
    (!input.requirement ||
      input.requirement.genomeLengthBp !== input.manifestGenomeLength ||
      input.requirement.broadCorridorFinestSpanBp !== input.manifestBroadCorridorFinestSpanBp)
  ) {
    return false;
  }
  if (input.themeMode !== INDEXED_ANNOTATION_COLOR_BASIS_THEME) return false;
  if (input.provenanceFailure !== null) return false;
  return true;
}
