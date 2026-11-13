export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let consumed = false;
  try {
    if (!response.ok || response.status >= 300) throw new Error('bad status');
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
      throw new Error('bad content type');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
      throw new Error('oversized response');
    reader = response.body?.getReader();
    if (!reader) throw new Error('missing response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('oversized response');
      chunks.push(next.value);
    }
    consumed = true;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    if (reader) {
      if (!consumed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  }
}
