import {
  readSequenceProductSummary,
  type SequenceProductSummaryRequest,
  type SequenceProductSummaryResponse,
} from './sequence-product-summary-runtime';

const scope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<SequenceProductSummaryRequest>) => void) | null;
  postMessage(response: SequenceProductSummaryResponse): void;
};

scope.onmessage = (event) => {
  const { id, content } = event.data;
  void readSequenceProductSummary(content).then(
    (summary) => scope.postMessage({ id, summary }),
    (error: unknown) =>
      scope.postMessage({
        id,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      })
  );
};
