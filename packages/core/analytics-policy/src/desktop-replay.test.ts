import { describe, expect, it } from 'vitest';
import { sanitizeDesktopReplayData } from './desktop-replay';
import { sanitizeSdkEvent } from './index';

const SAFE_HREF = 'dnaforge://desktop/sequence';
const USER_PATH = '/Users/alice/Lab/KRAS_G12C_secret.gb';

function element(
  tagName: string,
  attributes: Record<string, unknown>,
  childNodes: unknown[] = [],
  extra: Record<string, unknown> = {}
) {
  return {
    type: 2,
    id: Math.floor(Math.random() * 1e6),
    tagName,
    attributes,
    childNodes,
    ...extra,
  };
}

function text(textContent: string, extra: Record<string, unknown> = {}) {
  return { type: 3, id: Math.floor(Math.random() * 1e6), textContent, ...extra };
}

function fullSnapshot(node: unknown) {
  return { type: 2, timestamp: 1, data: { node, initialOffset: { left: 0, top: 0 } } };
}

describe('desktop replay sanitizer', () => {
  it('keeps layout and state attributes and drops labels, ids built from data, and URLs', () => {
    const [event] = sanitizeDesktopReplayData(
      [
        fullSnapshot(
          element('div', {
            class: 'flex gap-2',
            style: 'width: 12px; background-image: url(file:///Users/alice/x.png)',
            role: 'treeitem',
            'aria-expanded': 'true',
            'data-state': 'open',
            title: USER_PATH,
            'aria-label': 'Open KRAS_G12C_secret.gb',
            'data-testid': `tab-content-container-${USER_PATH}`,
            id: 'tab-content-9',
            href: 'file:///Users/alice/Lab',
            src: 'file:///Users/alice/Lab/gel.png',
            placeholder: 'Search KRAS',
            value: 'ACGT',
            rr_width: '120px',
          })
        ),
      ],
      SAFE_HREF
    ) as Array<{ data: { node: { attributes: Record<string, unknown> } } }>;

    expect(event.data.node.attributes).toEqual({
      class: 'flex gap-2',
      style: 'width: 12px; background-image: none',
      role: 'treeitem',
      'aria-expanded': 'true',
      'data-state': 'open',
      rr_width: '120px',
    });
  });

  it('masks every text node except stylesheet text and empties comments', () => {
    const [event] = sanitizeDesktopReplayData(
      [
        fullSnapshot(
          element('div', {}, [
            text('KRAS G12C primer'),
            text('.a { color: red }', { isStyle: true }),
            { type: 5, id: 3, textContent: 'secret note' },
          ])
        ),
      ],
      SAFE_HREF
    ) as Array<{ data: { node: { childNodes: Array<{ textContent: string }> } } }>;

    expect(event.data.node.childNodes.map((node) => node.textContent)).toEqual([
      '**** **** ******',
      '.a { color: red }',
      '',
    ]);
  });

  it('keeps SVG geometry and local paint references but not foreign references', () => {
    const [event] = sanitizeDesktopReplayData(
      [
        fullSnapshot(
          element(
            'svg',
            { viewBox: '0 0 24 24', id: 'grad-1', 'clip-path': 'url(#clip-1)' },
            [
              element('use', { href: '#icon-close' }, [], { isSVG: true }),
              element('use', { href: 'file:///Users/alice/sprite.svg#a' }, [], { isSVG: true }),
              element('path', { d: 'M0 0L1 1', mask: 'url(https://x.test/m)' }, [], {
                isSVG: true,
              }),
            ],
            { isSVG: true }
          )
        ),
      ],
      SAFE_HREF
    ) as Array<{
      data: {
        node: {
          attributes: Record<string, unknown>;
          childNodes: Array<{ attributes: Record<string, unknown> }>;
        };
      };
    }>;

    expect(event.data.node.attributes).toEqual({
      viewBox: '0 0 24 24',
      id: 'grad-1',
      'clip-path': 'url(#clip-1)',
    });
    expect(event.data.node.childNodes.map((node) => node.attributes)).toEqual([
      { href: '#icon-close' },
      {},
      { d: 'M0 0L1 1' },
    ]);
  });

  it('masks mutation text and input values and filters mutated attributes', () => {
    const sanitized = sanitizeDesktopReplayData(
      [
        {
          type: 3,
          timestamp: 2,
          data: {
            source: 0,
            texts: [{ id: 1, value: 'MyPlasmid.gb' }],
            attributes: [
              { id: 2, attributes: { title: USER_PATH, class: 'open', 'aria-label': null } },
            ],
            removes: [{ parentId: 1, id: 9 }],
            adds: [{ parentId: 1, nextId: null, node: text('KRAS') }],
          },
        },
        { type: 3, timestamp: 3, data: { source: 5, id: 4, text: 'my prompt', isChecked: false } },
      ],
      SAFE_HREF
    );

    expect(sanitized).toEqual([
      {
        type: 3,
        timestamp: 2,
        data: {
          source: 0,
          texts: [{ id: 1, value: '************' }],
          attributes: [{ id: 2, attributes: { class: 'open', 'aria-label': null } }],
          removes: [{ parentId: 1, id: 9 }],
          adds: [
            {
              parentId: 1,
              nextId: null,
              node: expect.objectContaining({ type: 3, textContent: '****' }),
            },
          ],
        },
      },
      { type: 3, timestamp: 3, data: { source: 5, id: 4, text: '** ******', isChecked: false } },
    ]);
  });

  it('replaces page URLs, keeps only network origins and timing, and drops canvas and console', () => {
    const sanitized = sanitizeDesktopReplayData(
      [
        { type: 4, timestamp: 1, data: { href: `file://${USER_PATH}`, width: 800, height: 600 } },
        {
          type: 5,
          timestamp: 2,
          data: { tag: '$pageview', payload: { href: `file://${USER_PATH}` } },
        },
        {
          type: 6,
          timestamp: 3,
          data: {
            plugin: 'rrweb/network@1',
            payload: {
              requests: [
                {
                  name: 'https://api.test/v1/sequence?path=%2FUsers%2Falice%2Fa.gb',
                  method: 'POST',
                  status: 200,
                  startTime: 1,
                  endTime: 5,
                  requestBody: 'ACGT',
                  responseHeaders: { 'set-cookie': 'x' },
                },
              ],
            },
          },
        },
        { type: 6, timestamp: 4, data: { plugin: 'rrweb/console@1', payload: { payload: ['x'] } } },
        { type: 3, timestamp: 5, data: { source: 9, id: 7, commands: [] } },
        { type: 3, timestamp: 6, data: { source: 2, type: 2, id: 7, x: 10, y: 20 } },
      ],
      SAFE_HREF
    );

    expect(sanitized).toEqual([
      { type: 4, timestamp: 1, data: { href: SAFE_HREF, width: 800, height: 600 } },
      { type: 5, timestamp: 2, data: { tag: '$pageview', payload: { href: SAFE_HREF } } },
      {
        type: 6,
        timestamp: 3,
        data: {
          plugin: 'rrweb/network@1',
          payload: {
            requests: [
              { name: 'https://api.test', method: 'POST', status: 200, startTime: 1, endTime: 5 },
            ],
          },
        },
      },
      { type: 3, timestamp: 6, data: { source: 2, type: 2, id: 7, x: 10, y: 20 } },
    ]);
  });

  it('removes file URLs and generated content text from every stylesheet path', () => {
    const [snapshot, rule, declaration, adopted] = sanitizeDesktopReplayData(
      [
        fullSnapshot(
          element('style', { _cssText: '.a{background:url(file:///Users/alice/x.png)}' }, [
            text('.b::before{content:"KRAS_G12C.gb";color:red}', { isStyle: true }),
          ])
        ),
        {
          type: 3,
          timestamp: 2,
          data: { source: 8, id: 1, adds: [{ rule: '.c{background:url("/Users/a/y.png")}' }] },
        },
        {
          type: 3,
          timestamp: 3,
          data: { source: 13, id: 1, set: { property: 'background', value: 'url(/tmp/z.png)' } },
        },
        {
          type: 3,
          timestamp: 4,
          data: {
            source: 15,
            id: 1,
            styles: [{ styleId: 1, rules: [{ rule: ".d::after{content:'secret'}" }] }],
          },
        },
      ],
      SAFE_HREF
    ) as Array<Record<string, unknown>>;

    const replay = JSON.stringify([snapshot, rule, declaration, adopted]);
    for (const leaked of ['alice', 'KRAS', 'y.png', 'z.png', 'secret']) {
      expect(replay).not.toContain(leaked);
    }
    expect(replay).toContain('color:red');
  });

  it('handles quoted url() paths and text-bearing declarations in every CSS form', () => {
    const records = sanitizeDesktopReplayData(
      [
        fullSnapshot(
          element('div', { style: 'background:url("/Users/a/b).png");--label:"KRAS"' }, [
            text('.e::before{content:"a" "KRAS" ;quotes:"«" "MyProject"}', { isStyle: true }),
          ])
        ),
        {
          type: 3,
          timestamp: 2,
          data: { source: 13, id: 1, set: { property: 'content', value: '"KRAS"' } },
        },
        {
          type: 3,
          timestamp: 3,
          data: {
            source: 0,
            texts: [],
            removes: [],
            adds: [],
            attributes: [{ id: 2, attributes: { style: { '--label': ['"KRAS"', ''] } } }],
          },
        },
      ],
      SAFE_HREF
    );

    const replay = JSON.stringify(records);
    for (const leaked of ['b).png', '.png', 'KRAS', 'MyProject']) {
      expect(replay).not.toContain(leaked);
    }
  });

  it('leaves ordinary application CSS intact so replays still render', () => {
    const css = '[data-state="open"] .f{font-family:"Inter",sans-serif;color:rgb(1 2 3)}';
    const [event] = sanitizeDesktopReplayData(
      [fullSnapshot(element('style', {}, [text(css, { isStyle: true })]))],
      SAFE_HREF
    ) as Array<{ data: { node: { childNodes: Array<{ textContent: string }> } } }>;
    expect(event.data.node.childNodes[0].textContent).toBe(css);
  });

  it('keeps only recorder lifecycle and location custom events, without free text', () => {
    const sanitized = sanitizeDesktopReplayData(
      [
        { type: 5, timestamp: 1, data: { tag: '$url_changed', payload: { href: USER_PATH } } },
        {
          type: 5,
          timestamp: 2,
          data: {
            tag: '$session_id_change',
            payload: { sessionId: 'abc-123', windowId: 'w-1', changeReason: 'session idle' },
          },
        },
        { type: 5, timestamp: 3, data: { tag: '$posthog_config', payload: { token: 'phc_x' } } },
        { type: 5, timestamp: 4, data: { tag: 'app-defined', payload: { note: 'KRAS' } } },
      ],
      SAFE_HREF
    );

    expect(sanitized).toEqual([
      { type: 5, timestamp: 1, data: { tag: '$url_changed', payload: { href: SAFE_HREF } } },
      {
        type: 5,
        timestamp: 2,
        data: { tag: '$session_id_change', payload: { sessionId: 'abc-123', windowId: 'w-1' } },
      },
    ]);
  });

  it('drops node types it does not recognize and empties character data', () => {
    const [event] = sanitizeDesktopReplayData(
      [
        fullSnapshot(
          element('div', {}, [
            { type: 4, id: 7, textContent: 'KRAS' },
            { type: 9, id: 8, textContent: 'KRAS' },
          ])
        ),
      ],
      SAFE_HREF
    ) as Array<{ data: { node: { childNodes: Array<{ type: number; textContent: string }> } } }>;

    expect(event.data.node.childNodes).toEqual([{ type: 4, id: 7, textContent: '' }]);
  });

  it('drops compressed and unrecognized events instead of forwarding them', () => {
    expect(
      sanitizeDesktopReplayData(
        [
          { type: 2, timestamp: 1, cv: '2024-10', data: 'H4sIAAAA' },
          { type: 99, timestamp: 2, data: {} },
          'not an event',
        ],
        SAFE_HREF
      )
    ).toBeNull();
  });

  it('runs on every desktop $snapshot and leaves web snapshots untouched', () => {
    const snapshot = [fullSnapshot(element('div', { title: USER_PATH }, [text('secret')]))];
    const desktop = sanitizeSdkEvent(
      { event: '$snapshot', properties: { $snapshot_data: snapshot } },
      'desktop',
      'sequence'
    );
    expect(JSON.stringify(desktop)).not.toContain('alice');
    expect(JSON.stringify(desktop)).not.toContain('secret');

    const web = sanitizeSdkEvent(
      { event: '$snapshot', properties: { $snapshot_data: snapshot } },
      'web'
    );
    expect(web?.properties.$snapshot_data).toEqual(snapshot);

    expect(
      sanitizeSdkEvent(
        {
          event: '$snapshot',
          properties: { $snapshot_data: [{ type: 2, cv: '2024-10', data: 'x' }] },
        },
        'desktop'
      )
    ).toBeNull();
  });
});
