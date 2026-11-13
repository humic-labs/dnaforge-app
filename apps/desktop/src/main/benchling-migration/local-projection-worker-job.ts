import type { RelationshipResolution, SourceObject } from '../../shared/benchling-migration';
import type { BenchlingMigrationActionAllocation } from '../../shared/benchling-migration-action-journal';
import {
  buildProjectionPlan,
  projectionDestinationObjectId,
  type ProjectionPlan,
} from './projection';
import { buildOutboundLocalLinkMap } from './relationship-link-map';

export const LOCAL_PROJECTION_WORKER_JOB_SCHEMA =
  'dnaforge.benchling.local-projection-worker-job.v2' as const;
export const LOCAL_PROJECTION_WORKER_RESULT_SCHEMA =
  'dnaforge.benchling.local-projection-worker-result.v1' as const;

export type LocalProjectionWorkerJob = Readonly<{
  schema: typeof LOCAL_PROJECTION_WORKER_JOB_SCHEMA;
  runId: string;
  capturedAt: string;
  converterVersion: string;
  sourceObjects: readonly SourceObject[];
  resolutions: readonly RelationshipResolution[];
  allocations: readonly BenchlingMigrationActionAllocation[];
}>;

export type LocalProjectionWorkerResult = Readonly<{
  schema: typeof LOCAL_PROJECTION_WORKER_RESULT_SCHEMA;
  plans: ReadonlyArray<Readonly<{ sourceObjectId: string; plan: ProjectionPlan }>>;
}>;

export function runLocalProjectionWorkerJob(
  job: LocalProjectionWorkerJob
): LocalProjectionWorkerResult {
  if (job.schema !== LOCAL_PROJECTION_WORKER_JOB_SCHEMA) {
    throw new Error('Local projection worker received an unsupported job schema.');
  }
  const linksBySourceObjectId = buildOutboundLocalLinkMap({
    resolutions: job.resolutions,
    sourceObjects: job.sourceObjects,
    receipts: job.sourceObjects.map((sourceObject) => {
      const destinationObjectId = projectionDestinationObjectId(sourceObject);
      return {
        sourceObjectId: sourceObject.id,
        destinationObjectId,
        destinationPath: `entity://migration/${destinationObjectId}`,
      };
    }),
  });
  const allocationBySourceObjectId = new Map(
    job.allocations.map((allocation) => [allocation.sourceObjectId, allocation])
  );
  if (
    allocationBySourceObjectId.size !== job.allocations.length ||
    job.sourceObjects.some((sourceObject) => !allocationBySourceObjectId.has(sourceObject.id)) ||
    job.allocations.some(
      (allocation) =>
        !job.sourceObjects.some((sourceObject) => sourceObject.id === allocation.sourceObjectId)
    )
  ) {
    throw new Error('Local projection worker requires one immutable allocation per source object.');
  }
  return {
    schema: LOCAL_PROJECTION_WORKER_RESULT_SCHEMA,
    plans: job.sourceObjects.map((sourceObject) => {
      const allocation = allocationBySourceObjectId.get(sourceObject.id);
      if (!allocation) {
        throw new Error('Local projection worker allocation disappeared after validation.');
      }
      if (allocation.installState !== 'reserved') {
        throw new Error('Local projection worker allocation must still be reserved.');
      }
      return {
        sourceObjectId: sourceObject.id,
        plan: buildProjectionPlan(sourceObject, {
          runId: job.runId,
          capturedAt: job.capturedAt,
          converterVersion: job.converterVersion,
          links: linksBySourceObjectId.get(sourceObject.id),
          destination: allocation.destination,
          destinationEntityId: allocation.destinationEntityId,
        }),
      };
    }),
  };
}
