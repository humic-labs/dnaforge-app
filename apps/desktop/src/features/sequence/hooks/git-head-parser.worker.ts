import { parseGenBankFull } from '@waypoint/sequence-utils';

export type GitHeadBaseline = Pick<ReturnType<typeof parseGenBankFull>, 'sequence' | 'annotations'>;
export type GitHeadParserResponse =
  | { result: GitHeadBaseline }
  | { error: { name: string; message: string } };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  postMessage(response: GitHeadParserResponse): void;
};

scope.onmessage = ({ data: content }) => {
  try {
    const { sequence, annotations } = parseGenBankFull(content);
    scope.postMessage({ result: { sequence, annotations } });
  } catch (error) {
    scope.postMessage({
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
