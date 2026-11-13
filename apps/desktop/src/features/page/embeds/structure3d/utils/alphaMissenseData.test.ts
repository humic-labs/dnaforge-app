// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function alphaMissenseCsv(position: number): string {
  return `protein_variant,am_pathogenicity,am_class\nM${position}A,0.75,pathogenic\n`;
}

describe('AlphaMissense memory cache', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('evicts the least-recently-used protein after sixteen cached results', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const id = /AF-(P\d+)-F1/.exec(url)?.[1];
      if (!id) throw new Error(`unexpected AlphaMissense URL: ${url}`);
      return new Response(alphaMissenseCsv(Number(id.slice(1)) + 1));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    for (let index = 0; index < 16; index += 1) {
      await fetchAlphaMissenseData(`P${String(index).padStart(5, '0')}`);
    }
    expect(fetchMock).toHaveBeenCalledTimes(16);

    await fetchAlphaMissenseData('P00000');
    expect(fetchMock).toHaveBeenCalledTimes(16);

    await fetchAlphaMissenseData('P00016');
    await fetchAlphaMissenseData('P00001');
    expect(fetchMock).toHaveBeenCalledTimes(18);

    await fetchAlphaMissenseData('P00000');
    expect(fetchMock).toHaveBeenCalledTimes(18);
  });

  it('queues a distinct accession until a bounded transport slot becomes available', async () => {
    const transportResolves: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          transportResolves.push(resolve);
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    const controllers = Array.from({ length: 17 }, () => new AbortController());
    const requests = controllers.map((controller, index) =>
      fetchAlphaMissenseData(`P${String(index).padStart(5, '0')}`, {
        signal: controller.signal,
      })
    );

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(16);
    transportResolves[0]?.(new Response(alphaMissenseCsv(1)));
    await expect(requests[0]).resolves.toEqual(new Map([[1, 0.75]]));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(17));

    for (const controller of controllers) controller.abort();
    await expect(Promise.all(requests)).resolves.toHaveLength(17);
  });

  it('rejects overflow distinctly instead of recording a permanent data miss', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    const controllers = Array.from({ length: 81 }, () => new AbortController());
    const requests = controllers.map((controller, index) =>
      fetchAlphaMissenseData(`P${String(index).padStart(5, '0')}`, {
        signal: controller.signal,
      })
    );

    await expect(requests[80]).rejects.toThrow('AlphaMissense request capacity queue is full');
    expect(fetchMock).toHaveBeenCalledTimes(16);

    for (const controller of controllers) controller.abort();
    await expect(Promise.all(requests.slice(0, 80))).resolves.toHaveLength(80);
  });

  it('aborts the shared transport only after its last consumer leaves', async () => {
    let transportSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal;
          transportSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    const first = new AbortController();
    const second = new AbortController();
    const firstRequest = fetchAlphaMissenseData('P12345', { signal: first.signal });
    const secondRequest = fetchAlphaMissenseData('P12345', { signal: second.signal });

    first.abort();
    await expect(firstRequest).resolves.toBeNull();
    expect(transportSignal?.aborted).toBe(false);

    second.abort();
    await expect(secondRequest).resolves.toBeNull();
    expect(transportSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out a hung transport and permits a later retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    const timedOut = fetchAlphaMissenseData('P99999');

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(timedOut).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(alphaMissenseCsv(7)));
    await expect(fetchAlphaMissenseData('P99999')).resolves.toEqual(new Map([[7, 0.75]]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses chunked responses without retaining every CSV row', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'protein_variant,am_pathogenicity,am_class\nM1A,0.25,benign\nM',
      '1C,0.75,pathogenic\nG2A,0.6,pathogenic\n',
    ].map((chunk) => encoder.encode(chunk));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 }))
    );

    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    await expect(fetchAlphaMissenseData('P12345')).resolves.toEqual(
      new Map([
        [1, 0.5],
        [2, 0.6],
      ])
    );
  });

  it('rejects a declared oversized response before reading its body', async () => {
    const read = vi.fn();
    const getReader = vi.fn(() => ({ read }));
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => String(48 * 1024 * 1024 + 1) },
        body: { cancel, getReader },
      }))
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    await expect(fetchAlphaMissenseData('P54321')).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('fails closed when the transport provides no bounded response stream', async () => {
    const text = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => null },
        body: null,
        text,
      }))
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    await expect(fetchAlphaMissenseData('P54322')).resolves.toBeNull();
    expect(text).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('evicts by total retained residues as well as accession count', async () => {
    const largeCsv = (offset: number): string => {
      const rows = ['protein_variant,am_pathogenicity,am_class'];
      for (let position = 1; position <= 30_000; position += 1) {
        rows.push(`M${position + offset}A,0.5,pathogenic`);
      }
      return `${rows.join('\n')}\n`;
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(largeCsv(0)))
      .mockResolvedValueOnce(new Response(largeCsv(30_000)))
      .mockResolvedValueOnce(new Response(largeCsv(0)));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchAlphaMissenseData } = await import('./alphaMissenseData');
    await expect(fetchAlphaMissenseData('P00001')).resolves.toHaveProperty('size', 30_000);
    await expect(fetchAlphaMissenseData('P00002')).resolves.toHaveProperty('size', 30_000);
    await expect(fetchAlphaMissenseData('P00001')).resolves.toHaveProperty('size', 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
