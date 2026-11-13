import type { WorkspaceMutationOptions as RendererWorkspaceMutationOptions } from '../shared/artifact-operation-ports';
import { platform } from '../platform';

const passiveAdmissionTails = new Map<string, Promise<void>>();

async function beginPassiveWorkspaceMutation(
  root: string,
  begin: NonNullable<ReturnType<typeof platform>['fs']['beginWorkspaceMutation']>
): Promise<string> {
  const previous = passiveAdmissionTails.get(root) ?? Promise.resolve();
  const admission = previous.catch(() => undefined).then(() => begin(root, undefined, true));
  const settled = admission.then(
    () => undefined,
    () => undefined
  );
  passiveAdmissionTails.set(root, settled);
  try {
    return await admission;
  } finally {
    if (passiveAdmissionTails.get(root) === settled) passiveAdmissionTails.delete(root);
  }
}

export function isWorkspaceMutationBusyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('WORKSPACE_SYNC_MUTATION_BUSY');
}

export async function withRendererWorkspaceMutation<T>(
  workspaceRoot: string | null | undefined,
  operation: (mutationToken?: string) => Promise<T>,
  parentToken?: string,
  options: RendererWorkspaceMutationOptions = {}
): Promise<T> {
  const root = workspaceRoot?.trim();
  const fileSystem = platform().fs;
  const begin = fileSystem?.beginWorkspaceMutation;
  const end = fileSystem?.endWorkspaceMutation;
  if (!root || !begin || !end) return operation();

  const token =
    options.waitForAvailability && !parentToken
      ? await beginPassiveWorkspaceMutation(root, begin)
      : options.waitForAvailability
        ? await begin(root, parentToken, true)
        : await begin(root, parentToken);
  try {
    return await operation(token);
  } finally {
    await end(token);
  }
}
