/// <reference lib="webworker" />
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { GitHeadParseResponse } from './git-head-parser.protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<{ content: string }>) => {
  let response: GitHeadParseResponse;
  try {
    const parsed = parseGenBankFull(event.data.content);
    response = {
      type: 'result',
      result: { sequence: parsed.sequence, annotations: parsed.annotations },
    };
  } catch (error) {
    response = { type: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  ctx.postMessage(response);
};
