import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldAllowMajorPerformanceCaveat } from './pluginConfig';

type ContextRequest = { type: string; attrs?: WebGLContextAttributes };

function stubCanvas(decide: (req: ContextRequest) => unknown): ContextRequest[] {
  const requests: ContextRequest[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
    if (tag !== 'canvas') {
      return original(tag as 'div', ...(rest as []));
    }
    return {
      getContext: (type: string, attrs?: WebGLContextAttributes) => {
        requests.push({ type, attrs });
        return decide({ type, attrs });
      },
    } as unknown as HTMLElement;
  });
  return requests;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldAllowMajorPerformanceCaveat', () => {
  it('does NOT relax the requirement when real hardware is available', () => {
    const requests = stubCanvas(({ attrs }) => (attrs?.failIfMajorPerformanceCaveat ? {} : {}));

    expect(shouldAllowMajorPerformanceCaveat()).toBe(false);
    expect(requests[0]).toEqual({
      type: 'webgl2',
      attrs: { failIfMajorPerformanceCaveat: true },
    });
    expect(requests).toHaveLength(1);
  });

  it('relaxes the requirement when only software rendering is available', () => {
    const requests = stubCanvas(({ attrs }) => (attrs?.failIfMajorPerformanceCaveat ? null : {}));

    expect(shouldAllowMajorPerformanceCaveat()).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ type: 'webgl2', attrs: undefined });
  });

  it('does NOT relax when no WebGL2 is available at all', () => {
    stubCanvas(() => null);
    expect(shouldAllowMajorPerformanceCaveat()).toBe(false);
  });

  it('fails closed when the probe itself throws', () => {
    stubCanvas(() => {
      throw new Error('getContext exploded');
    });
    expect(shouldAllowMajorPerformanceCaveat()).toBe(false);
  });

  it('uses a FRESH canvas for the relaxed retry', () => {
    const seen: unknown[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
      if (tag !== 'canvas') return original(tag as 'div', ...(rest as []));
      const canvas = {
        getContext: (_type: string, attrs?: WebGLContextAttributes) =>
          attrs?.failIfMajorPerformanceCaveat ? null : {},
      };
      seen.push(canvas);
      return canvas as unknown as HTMLElement;
    });

    expect(shouldAllowMajorPerformanceCaveat()).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
