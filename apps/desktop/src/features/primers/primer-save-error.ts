export function primerSaveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Failed to save';
  if (message.includes('WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH')) {
    return 'The save location belongs to a different project. Choose a folder in the owning project and save again. Your primer draft is still here.';
  }
  if (message.includes('WORKSPACE_MUTATION_UNKNOWN_WORKSPACE')) {
    return 'The save project is no longer available. Open that project or choose another save folder, then save again. Your primer draft is still here.';
  }
  if (message.includes('WORKSPACE_MUTATION_TOKEN_INVALID')) {
    return 'The project changed while saving. Check the save location and save again. Your primer draft is still here.';
  }
  return message;
}
