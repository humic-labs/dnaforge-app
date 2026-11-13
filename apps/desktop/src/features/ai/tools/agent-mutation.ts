export type AgentMutationEffect =
  | 'created_design'
  | 'added_design_region'
  | 'drafted_design_assembly'
  | 'set_junction_spacer'
  | 'set_primer_pbs_length'
  | 'updated_assembly_primer'
  | 'set_primer_overhang_length'
  | 'set_golden_gate_offset'
  | 'set_golden_gate_schema'
  | 'set_moclo_factory_stage'
  | 'set_pcr_polymerase'
  | 'placed_digest_fragment'
  | 'removed_design_region'
  | 'reordered_design_regions'
  | 'applied_overhang_optimization';

export type AgentMutationClaim = {
  operationId: string;
  toolName: string;
  effect: AgentMutationEffect;
  target: {
    type: 'design';
    id: string;
  };
  resourceUri: string;
  beforeVersion: number | null;
  afterVersion: number | null;
  changed: boolean;
  expected?: Record<string, unknown>;
};

export function designResourceUri(designId: string): string {
  return `waypoint://design/${encodeURIComponent(designId)}`;
}

export function createDesignMutationClaim({
  operationId,
  toolName,
  effect,
  designId,
  beforeVersion,
  afterVersion,
  changed,
  expected,
}: {
  operationId?: string;
  toolName: string;
  effect: AgentMutationEffect;
  designId: string;
  beforeVersion: number | null;
  afterVersion: number | null;
  changed: boolean;
  expected?: Record<string, unknown>;
}): AgentMutationClaim {
  return {
    operationId: operationId || `renderer-${toolName}-${designId}`,
    toolName,
    effect,
    target: {
      type: 'design',
      id: designId,
    },
    resourceUri: designResourceUri(designId),
    beforeVersion,
    afterVersion,
    changed,
    ...(expected ? { expected } : {}),
  };
}
