export const PORTAL_REATTACH_STABLE_WIDTH_SAMPLES = 4;

export interface PortalWidthStability {
  candidateWidth: number | null;
  consecutiveSamples: number;
}

export const INITIAL_PORTAL_WIDTH_STABILITY: PortalWidthStability = {
  candidateWidth: null,
  consecutiveSamples: 0,
};

export interface PortalWidthStabilityResult {
  state: PortalWidthStability;
  settled: boolean;
}

export function samplePortalReattachWidth(
  state: PortalWidthStability,
  width: number
): PortalWidthStabilityResult {
  if (width <= 0) {
    return {
      state: INITIAL_PORTAL_WIDTH_STABILITY,
      settled: false,
    };
  }

  const matchesCandidate =
    state.candidateWidth !== null && Math.abs(width - state.candidateWidth) <= 1;
  const nextState: PortalWidthStability = matchesCandidate
    ? {
        candidateWidth: state.candidateWidth,
        consecutiveSamples: state.consecutiveSamples + 1,
      }
    : {
        candidateWidth: width,
        consecutiveSamples: 1,
      };

  return {
    state: nextState,
    settled: nextState.consecutiveSamples >= PORTAL_REATTACH_STABLE_WIDTH_SAMPLES,
  };
}
