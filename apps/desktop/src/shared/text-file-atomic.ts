export interface TextFileAtomicWriteInput {
  readonly path: string;
  readonly content: string;
  readonly expectedContentHash?: string;
}

export function assertTextFileAtomicWriteInput(
  input: unknown
): asserts input is TextFileAtomicWriteInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Atomic text-file write input must be an object.');
  }
  const keys = Object.keys(input).sort();
  if (keys.some((key) => !['content', 'path', 'expectedContentHash'].includes(key))) {
    throw new Error(
      'Atomic text-file write input must contain only path and content, with an optional expectedContentHash.'
    );
  }
  if (!('path' in input) || typeof input.path !== 'string' || input.path.length === 0) {
    throw new Error('Atomic text-file write path must be a non-empty string.');
  }
  if (!('content' in input) || typeof input.content !== 'string') {
    throw new Error('Atomic text-file write content must be a string.');
  }
  if (
    'expectedContentHash' in input &&
    (typeof input.expectedContentHash !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(input.expectedContentHash))
  ) {
    throw new Error('Atomic text-file write expectedContentHash must be a SHA-256 identity.');
  }
}
