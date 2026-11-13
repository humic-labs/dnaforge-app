export const COMPILED_BROAD_SURFACE_REQUIREMENT_V1 =
  'compiled-broad-surface-requirement.v1' as const;

export interface CompiledBroadSurfaceRequirementV1 {
  readonly contract?: typeof COMPILED_BROAD_SURFACE_REQUIREMENT_V1;
  readonly genomeLengthBp: number;
  readonly broadCorridorFinestSpanBp: number;
}

export class IndexedCompiledBroadRequirement {
  current: Readonly<{
    genomeLengthBp: number;
    broadCorridorFinestSpanBp: number;
  }> | null = null;

  require(
    input: CompiledBroadSurfaceRequirementV1,
    host: { genomeLength: number; hasAdmittedSurface: boolean }
  ): boolean {
    const genomeLengthBp = input?.genomeLengthBp;
    const broadCorridorFinestSpanBp = input?.broadCorridorFinestSpanBp;
    if (
      !Number.isSafeInteger(genomeLengthBp) ||
      genomeLengthBp <= 0 ||
      !Number.isSafeInteger(broadCorridorFinestSpanBp) ||
      broadCorridorFinestSpanBp <= 0 ||
      broadCorridorFinestSpanBp > genomeLengthBp ||
      (host.genomeLength > 0 && genomeLengthBp !== host.genomeLength)
    ) {
      return false;
    }
    const existing = this.current;
    if (existing) {
      const exactRequirement =
        existing.genomeLengthBp === genomeLengthBp &&
        existing.broadCorridorFinestSpanBp === broadCorridorFinestSpanBp;
      if (exactRequirement) return true;
      if (existing.genomeLengthBp !== genomeLengthBp) return false;
      if (host.hasAdmittedSurface) return true;
    }
    this.current = Object.freeze({
      genomeLengthBp,
      broadCorridorFinestSpanBp,
    });
    return true;
  }

  clear(): void {
    this.current = null;
  }
}
