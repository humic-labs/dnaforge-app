export async function runMolecularExperimentQueue<Job, Result>(
  jobs: readonly Job[],
  concurrency: number,
  execute: (job: Job, index: number) => Promise<Result>,
  stopDispatch?: AbortSignal
): Promise<Array<PromiseSettledResult<Result>>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Experiment concurrency must be a positive integer.');
  const results: Array<PromiseSettledResult<Result>> = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length && !stopDispatch?.aborted) {
        const index = next++;
        try {
          results[index] = { status: 'fulfilled', value: await execute(jobs[index], index) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })
  );
  return results.filter((result): result is PromiseSettledResult<Result> => result !== undefined);
}
