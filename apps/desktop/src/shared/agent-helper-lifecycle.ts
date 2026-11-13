export interface AgentHelperLifecycleSnapshot {
  readonly active: number;
  readonly started: number;
  readonly settled: number;
  readonly peakActive: number;
}
