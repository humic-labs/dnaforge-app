export const HOSTED_REFERENCE_INSTALL_PHASES = [
  'started',
  'annotation_ready',
  'ready',
  'failed',
] as const;

export const HOSTED_REFERENCE_INSTALL_STAGES = [
  'queued_hosted_reference',
  'resolving_hosted_reference',
  'checking_hosted_reference',
  'checking_prepared_bundle',
  'prepared_bundle_fallback',
  'downloading_reference',
  'verifying_download',
  'downloading_hub_sequence',
  'unpacking_hub_sequence',
  'hub_genome_selected',
  'inspecting_sources',
  'sources_selected',
  'source_recognized',
  'source_published',
  'verifying_publication',
  'indexing_reference',
  'preparing_reference_products',
  'building_visualization',
  'building_search',
  'summarizing_annotations',
  'materializing',
  'expanding',
  'transport',
  'objects',
  'manifest',
  'detail_ready',
  'other',
] as const;

export type HostedReferenceInstallPhase = (typeof HOSTED_REFERENCE_INSTALL_PHASES)[number];
export type HostedReferenceInstallStage = (typeof HOSTED_REFERENCE_INSTALL_STAGES)[number];

const STAGES: ReadonlySet<string> = new Set(HOSTED_REFERENCE_INSTALL_STAGES);

export function hostedReferenceInstallStage(
  phase: string | undefined
): HostedReferenceInstallStage {
  const normalized = (phase ?? '').replace(/-/g, '_');
  return STAGES.has(normalized) ? (normalized as HostedReferenceInstallStage) : 'other';
}
