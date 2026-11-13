const LOCAL_BUNDLE_TIMING_ENV = 'DNAFORGE_BENCHLING_MIGRATION_TIMING';

export type LocalBundleTimedPhase =
  | 'intake'
  | 'preflight'
  | 'parsing'
  | 'parsing_decode'
  | 'parsing_commit'
  | 'offline_resolution'
  | 'offline_resolution_compute'
  | 'targeted_reads'
  | 'projecting'
  | 'projection_objects'
  | 'projection_plan_build'
  | 'projection_install'
  | 'projection_collections'
  | 'projection_commit'
  | 'effects_catalog'
  | 'effects_files'
  | 'effects_receipts'
  | 'effects_publish'
  | 'validating';

export type LocalBundlePhaseTiming = Readonly<{
  phase: LocalBundleTimedPhase;
  durationMs: number;
  itemCount: number;
}>;

export function traceLocalBundlePhaseTiming(timing: LocalBundlePhaseTiming): void {
  if (process.env[LOCAL_BUNDLE_TIMING_ENV] !== '1') return;
  console.info('[benchling-local-bundle-timing]', {
    phase: timing.phase,
    durationMs: Number(timing.durationMs.toFixed(2)),
    itemCount: timing.itemCount,
  });
}
