import { findORFs } from '@waypoint/sequence-utils';
import type { ORF } from '@waypoint/sequence-utils';
import type { PackedORFResult } from './orf-worker-protocol';
import type { ORFWorkerRequest, ORFWorkerResponse } from './orf-worker-protocol';

const ctx = self as typeof self & {
  postMessage: (msg: ORFWorkerResponse, transfer?: Transferable[]) => void;
  addEventListener: (
    type: 'message',
    handler: (event: MessageEvent<ORFWorkerRequest>) => void
  ) => void;
};

let activeJobId = -1;
const cancelledJobIds = new Set<number>();

function post(msg: ORFWorkerResponse) {
  ctx.postMessage(msg);
}

function packORFs(orfs: ORF[]): PackedORFResult {
  const starts = new Int32Array(orfs.length);
  const ends = new Int32Array(orfs.length);
  const frames = new Int8Array(orfs.length);
  const strands = new Int8Array(orfs.length);
  const lengths = new Int32Array(orfs.length);

  for (let i = 0; i < orfs.length; i++) {
    const orf = orfs[i];
    starts[i] = orf.start;
    ends[i] = orf.end;
    frames[i] = orf.frame;
    strands[i] = orf.strand === '+' ? 1 : -1;
    lengths[i] = orf.length;
  }

  return { starts, ends, frames, strands, lengths };
}

function postPackedDone(jobId: number, orfs: ORF[]) {
  const packed = packORFs(orfs);
  ctx.postMessage({ type: 'done', jobId, packed }, [
    packed.starts.buffer,
    packed.ends.buffer,
    packed.frames.buffer,
    packed.strands.buffer,
    packed.lengths.buffer,
  ] as Transferable[]);
}

function runDetect(req: Extract<ORFWorkerRequest, { type: 'detect' }>) {
  activeJobId = req.jobId;
  const myJobId = req.jobId;

  setTimeout(() => {
    if (activeJobId !== myJobId || cancelledJobIds.has(myJobId)) {
      post({ type: 'cancelled', jobId: myJobId });
      cancelledJobIds.delete(myJobId);
      return;
    }

    try {
      const orfs = findORFs(req.sequence, req.minLength, {
        ...(req.geneticCode !== undefined ? { geneticCode: req.geneticCode } : {}),
      });
      if (activeJobId !== myJobId || cancelledJobIds.has(myJobId)) {
        post({ type: 'cancelled', jobId: myJobId });
        return;
      }
      postPackedDone(myJobId, orfs);
    } catch (err) {
      post({
        type: 'error',
        jobId: myJobId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      cancelledJobIds.delete(myJobId);
    }
  }, 0);
}

ctx.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'detect') {
    runDetect(msg);
  } else if (msg.type === 'cancel') {
    cancelledJobIds.add(msg.jobId);
  }
});
