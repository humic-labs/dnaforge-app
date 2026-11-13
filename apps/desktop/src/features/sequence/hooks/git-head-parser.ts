import GitHeadParserWorker from './git-head-parser.worker.ts?worker&inline';
import type { GitHeadBaseline, GitHeadParserResponse } from './git-head-parser.worker';

export function parseGitHeadOffThread(
  content: string,
  signal: AbortSignal
): Promise<GitHeadBaseline> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const worker = new GitHeadParserWorker();
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      complete();
    };
    const onAbort = () => settle(() => reject(signal.reason));

    worker.onmessage = ({ data }: MessageEvent<GitHeadParserResponse>) => {
      settle(() => {
        if ('error' in data) {
          const error = new Error(data.error.message);
          error.name = data.error.name;
          reject(error);
        } else resolve(data.result);
      });
    };
    worker.onerror = (event) =>
      settle(() => reject(new Error(event.message || 'Git HEAD parser worker failed.')));
    worker.onmessageerror = () =>
      settle(() => reject(new Error('Git HEAD parser worker returned an unreadable message.')));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      worker.postMessage(content);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
