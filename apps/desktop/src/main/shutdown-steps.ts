export interface ShutdownStep {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export interface ShutdownStepFailure {
  readonly name: string;
  readonly error: unknown;
}

function logShutdownStepFailure({ name, error }: ShutdownStepFailure): void {
  console.error(`[main] shutdown step "${name}" failed:`, error);
}

export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  onFailure: (failure: ShutdownStepFailure) => void = logShutdownStepFailure
): Promise<readonly ShutdownStepFailure[]> {
  const failures: ShutdownStepFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const failure = { name: step.name, error };
      failures.push(failure);
      onFailure(failure);
    }
  }
  return failures;
}
