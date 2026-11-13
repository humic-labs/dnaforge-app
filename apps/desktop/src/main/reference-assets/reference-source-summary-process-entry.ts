import { preferCurrentThread } from '../thread-scheduling.cjs';
import {
  ensureChromosomeSourceSummaryV1,
  type ChromosomeSourceSummaryJobV1,
} from './reference-source-summary';

preferCurrentThread('userInitiated');

if (!process.send) {
  throw new Error('Source summary process started without an IPC channel.');
}
const send = process.send.bind(process);

process.on('message', (request: { id: number; job: ChromosomeSourceSummaryJobV1 }) => {
  ensureChromosomeSourceSummaryV1(request.job).then(
    () => send({ id: request.id }),
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      send({ id: request.id, error: { name: normalized.name, message: normalized.message } });
    }
  );
});
