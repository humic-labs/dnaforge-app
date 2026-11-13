import { runWorkflowAction } from '../lib/workflow-telemetry';
import type { RegistryMutationOptions } from '../shared/artifact-operation-ports';
import { platform } from '../platform';
import type {
  LimsEntity,
  LimsUpdateEntityInput,
  ScientificStrainEditAuthority,
} from '../shared/lims';
import { updateAcceptedStrain } from './update-accepted-strain';

export function updateLimsEntity(
  input: LimsUpdateEntityInput,
  options: RegistryMutationOptions & { scientificAuthority?: ScientificStrainEditAuthority } = {}
): Promise<LimsEntity> {
  const captured = structuredClone(input);
  const capturedOptions = structuredClone(options);
  return runWorkflowAction(
    {
      workflow: 'registry',
      action: 'update',
      initiator: capturedOptions.initiator,
      workflowOrigin: capturedOptions.workflowOrigin ?? 'direct',
      parentActionId: capturedOptions.parentActionId,
    },
    () =>
      capturedOptions.scientificAuthority
        ? updateAcceptedStrain(
            captured,
            capturedOptions.scientificAuthority,
            capturedOptions.mutationToken
          )
        : platform().lims.updateEntity(captured, capturedOptions.mutationToken),
    () => ({ status: 'updated', affectedCount: 1 })
  );
}
