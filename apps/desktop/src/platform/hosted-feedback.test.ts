import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostedBrowserBridge } from './hosted';

const id = '123e4567-e89b-42d3-a456-426614174000';
const payload = {
  message: 'Harmless feedback delivery fixture',
  app_version: 'test',
  platform_info: 'test browser',
  submission_id: id,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hosted feedback delivery', () => {
  it('confirms the existing protocol and accepts only its matching submission receipt', async () => {
    const request = vi.fn(async (_url: string, options?: RequestInit) =>
      options?.method === 'POST'
        ? Response.json({ ok: true, submission_id: id }, { status: 201 })
        : Response.json({ protocol: 'dnaforge.feedback.v1' })
    );
    vi.stubGlobal('fetch', request);

    await expect(hostedBrowserBridge.feedback.send(payload)).resolves.toEqual({
      success: true,
      submission_id: id,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual([
      '/api/feedback',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    ]);
    expect(request.mock.calls[1][0]).toBe('/api/feedback');
    const posted = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(posted).toMatchObject(payload);
    expect(posted).not.toHaveProperty('install_id');
    expect(posted).not.toHaveProperty('queue_state');
  });

  it('keeps a mismatched successful response unconfirmed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) =>
        options?.method === 'POST'
          ? Response.json({ ok: true, submission_id: 'a different submission' })
          : Response.json({ protocol: 'dnaforge.feedback.v1' })
      )
    );

    await expect(hostedBrowserBridge.feedback.send(payload)).resolves.toEqual({
      success: false,
      submission_id: id,
      error: 'delivery_unconfirmed',
    });
  });

  it('refuses a different protocol before posting the draft', async () => {
    const request = vi.fn(async () => Response.json({ protocol: 'unrelated service' }));
    vi.stubGlobal('fetch', request);

    await expect(hostedBrowserBridge.feedback.send(payload)).resolves.toEqual({
      success: false,
      submission_id: id,
      error: 'service_unavailable',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not claim a local queue or forward private server details on failed delivery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) =>
        options?.method === 'POST'
          ? Response.json({ error: 'private provider exception' }, { status: 503 })
          : Response.json({ protocol: 'dnaforge.feedback.v1' })
      )
    );

    await expect(hostedBrowserBridge.feedback.send(payload)).resolves.toEqual({
      success: false,
      submission_id: id,
      error: 'transport_unavailable',
    });
  });

  it('stops waiting on its active request when the shared form cancels', async () => {
    const request = vi.fn((_url: string, options?: RequestInit) =>
      options?.method === 'POST'
        ? new Promise<Response>(() => undefined)
        : Promise.resolve(Response.json({ protocol: 'dnaforge.feedback.v1' }))
    );
    vi.stubGlobal('fetch', request);
    const pending = hostedBrowserBridge.feedback.send(payload);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    await expect(hostedBrowserBridge.feedback.cancel(id)).resolves.toEqual({
      success: false,
      submission_id: id,
      error: 'cancelled',
    });
    await expect(pending).resolves.toEqual({
      success: false,
      submission_id: id,
      error: 'cancelled',
    });
    expect(request.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });
});
