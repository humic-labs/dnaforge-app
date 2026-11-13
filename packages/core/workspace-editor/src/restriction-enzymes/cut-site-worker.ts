import {
  scanAllStreaming,
  type CutSiteWorkerRequest,
  type CutSiteWorkerResponse,
  type ThinCutSiteHit,
} from '@waypoint/sequence-utils';

const ctx = self as typeof self & {
  postMessage: (msg: CutSiteWorkerResponse) => void;
  addEventListener: (
    type: 'message',
    handler: (event: MessageEvent<CutSiteWorkerRequest>) => void
  ) => void;
};

let activeJobId = -1;
let cancelledJobId = -1;

function post(msg: CutSiteWorkerResponse) {
  ctx.postMessage(msg);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runScan(req: Extract<CutSiteWorkerRequest, { type: 'scan' }>) {
  activeJobId = req.jobId;
  const myJobId = req.jobId;

  try {
    await scanAllStreaming(
      req.sequence,
      req.enzymes,
      {
        onProgress: (enzymeName, hits, enzymeIndex, totalEnzymes) => {
          if (myJobId !== activeJobId || cancelledJobId === myJobId) return;
          post({
            type: 'progress',
            jobId: myJobId,
            enzymeName,
            enzymeIndex,
            totalEnzymes,
            hits: hits as ThinCutSiteHit[],
          });
        },
        onEnzymeDone: (enzymeName, enzymeIndex, totalEnzymes) => {
          if (myJobId !== activeJobId || cancelledJobId === myJobId) return;
          post({
            type: 'enzyme-done',
            jobId: myJobId,
            enzymeName,
            enzymeIndex,
            totalEnzymes,
          });
        },
        yieldToEventLoop,
        isCancelled: () => myJobId !== activeJobId || cancelledJobId === myJobId,
      },
      { maxHitsPerEnzyme: req.maxHitsPerEnzyme, circular: req.circular }
    );

    if (myJobId !== activeJobId || cancelledJobId === myJobId) {
      post({ type: 'cancelled', jobId: myJobId });
    } else {
      post({ type: 'done', jobId: myJobId });
    }
  } catch (err) {
    post({
      type: 'error',
      jobId: myJobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

ctx.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'scan') {
    runScan(msg);
  } else if (msg.type === 'cancel') {
    cancelledJobId = msg.jobId;
  }
});
