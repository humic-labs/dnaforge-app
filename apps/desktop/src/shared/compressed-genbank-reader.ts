import { DocumentReadError } from './document-read-failure';
import { HARD_CAP_BYTES } from './oversized-guard';

export async function readCompressedGenBank(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > HARD_CAP_BYTES) throw new DocumentReadError('too-large');
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let decodedBytes = 0;
  const text: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      decodedBytes += chunk.value.byteLength;
      if (decodedBytes > HARD_CAP_BYTES) throw new DocumentReadError('too-large');
      text.push(decoder.decode(chunk.value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join('');
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        'code' in error &&
        (error.code === 'Z_DATA_ERROR' || error.code === 'Z_BUF_ERROR'))
    )
      throw new DocumentReadError('malformed', false, { cause: error });
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
