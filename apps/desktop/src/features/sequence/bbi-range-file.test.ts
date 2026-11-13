// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { BbiRangeFile } from './bbi-range-file';

const LIMIT = 8 * 1024 * 1024;

function fileFor(size: number, afterFetch?: () => void, maxRangeBytes?: number) {
  const ranges: string[] = [];
  const fetch = vi.fn(async (_url: RequestInfo, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>).range;
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`Expected a byte range, received ${JSON.stringify(range)}`);
    const [, from, to] = match;
    const start = Number(from);
    const end = Math.min(size - 1, Number(to));
    if (Number(to) - start + 1 > LIMIT || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    afterFetch?.();
    return new Response(new Uint8Array(end - start + 1).fill(start < LIMIT ? 1 : 2), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  });
  return {
    file: new BbiRangeFile('https://example.org/large.bb', { fetch, maxRangeBytes }),
    ranges,
  };
}

describe('BBI reads through the bounded range service', () => {
  it('honors a smaller website response bound without changing the logical read', async () => {
    const maxRangeBytes = 4_000_000;
    const { file, ranges } = fileFor(maxRangeBytes + 17, undefined, maxRangeBytes);
    const data = await file.read(maxRangeBytes + 17, 0);
    expect(data.length).toBe(maxRangeBytes + 17);
    expect(ranges).toEqual([
      `bytes=0-${maxRangeBytes - 1}`,
      `bytes=${maxRangeBytes}-${maxRangeBytes + 16}`,
    ]);
  });
  it('assembles an oversized logical read from valid contiguous HTTP ranges', async () => {
    const { file, ranges } = fileFor(LIMIT + 17);
    const data = await file.read(LIMIT + 17, 0);
    expect(data.length).toBe(LIMIT + 17);
    expect(ranges).toEqual([`bytes=0-${LIMIT - 1}`, `bytes=${LIMIT}-${LIMIT + 16}`]);
    expect(data[LIMIT - 1]).toBe(1);
    expect(data[LIMIT]).toBe(2);
    expect(data[LIMIT + 16]).toBe(2);
  });

  it('preserves a short final read at the actual end of the file', async () => {
    const { file, ranges } = fileFor(LIMIT + 7);
    const data = await file.read(LIMIT + 100, 0);
    expect(data.length).toBe(LIMIT + 7);
    expect(ranges).toHaveLength(2);
    expect(data[LIMIT + 6]).toBe(2);
  });

  it('does not make another request after its owner cancels between chunks', async () => {
    const controller = new AbortController();
    const { file, ranges } = fileFor(LIMIT + 17, () => controller.abort());
    await expect(file.read(LIMIT + 17, 0, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(ranges).toHaveLength(1);
  });

  it('keeps an ordinary small range as one request', async () => {
    const { file, ranges } = fileFor(32);
    const data = await file.read(17, 5);
    expect(data.length).toBe(17);
    expect(ranges).toEqual(['bytes=5-21']);
  });
});
