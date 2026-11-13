import GitHeadParserWorker from './git-head-parser.worker.ts?worker&inline';
import type { GitHeadParseResult, GitHeadParseResponse } from './git-head-parser.protocol';
export type { GitHeadParseResult, GitHeadParseResponse } from './git-head-parser.protocol';

export async function parseGitHeadInWorker(
  content: string,
  signal: AbortSignal
): Promise<GitHeadParseResult> {
  if (signal.aborted) throw signal.reason;
  const worker = new GitHeadParserWorker();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onMessage = (event: MessageEvent<GitHeadParseResponse>) => {
      const message = event.data;
      if (message?.type === 'result') {
        settle(() => resolve(message.result));
      } else {
        settle(() =>
          reject(
            new Error(
              message?.type === 'error' ? message.message : 'Invalid Git HEAD parse response'
            )
          )
        );
      }
    };
    const onError = (event: ErrorEvent) => {
      settle(() => reject(new Error(event.message || 'Git HEAD parser worker failed')));
    };
    const onMessageError = () => {
      settle(() => reject(new Error('Git HEAD parser returned an unreadable message')));
    };
    const onAbort = () => settle(() => reject(signal.reason));
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage({ content });
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
