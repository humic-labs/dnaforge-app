import { RemoteFile, type FilehandleOptions } from 'generic-filehandle2';

const MAX_SIDECAR_RANGE_BYTES = 8 * 1024 * 1024;
type RangeFileOptions = NonNullable<ConstructorParameters<typeof RemoteFile>[1]> & {
  maxRangeBytes?: number;
};

export class BbiRangeFile extends RemoteFile {
  private readonly maxRangeBytes: number;

  constructor(
    url: string,
    { maxRangeBytes = MAX_SIDECAR_RANGE_BYTES, ...options }: RangeFileOptions = {}
  ) {
    super(url, options);
    if (!Number.isSafeInteger(maxRangeBytes) || maxRangeBytes <= 0) {
      throw new RangeError('Invalid indexed-track range limit');
    }
    this.maxRangeBytes = Math.min(MAX_SIDECAR_RANGE_BYTES, maxRangeBytes);
  }

  override async read(
    length: number,
    position = 0,
    opts: FilehandleOptions = {}
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (length <= this.maxRangeBytes) return super.read(length, position, opts);
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < length) {
      opts.signal?.throwIfAborted();
      const requested = Math.min(this.maxRangeBytes, length - received);
      const chunk = await super.read(requested, position + received, opts);
      chunks.push(chunk);
      received += chunk.length;
      if (chunk.length < requested) break;
    }
    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
