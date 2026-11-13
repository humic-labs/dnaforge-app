import { platform } from '../platform';
import { createProjectMemoryOwner } from './project-memory-owner';
export * from './project-memory-owner';
const owner = createProjectMemoryOwner(() => platform().fs);
export const readProjectMemory = owner.readProjectMemory;
export const appendProjectMemoryEvent: typeof owner.appendProjectMemoryEvent = (input) => {
  if (!input.workspaceRoot) return Promise.resolve(null);
  const appendInMain = platform().fs.appendProjectMemoryEvent;
  return appendInMain
    ? appendInMain({ ...input, workspaceRoot: input.workspaceRoot })
    : owner.appendProjectMemoryEvent(input);
};
