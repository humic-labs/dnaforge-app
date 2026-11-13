// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGoogleSheetsHandlers } from './google-sheets';

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  status: vi.fn(async () => ({ configured: false })),
  start: vi.fn(async () => 'request'),
  cancel: vi.fn(() => true),
  forget: vi.fn(async () => {}),
  spreadsheet: vi.fn(async () => ({})),
  worksheet: vi.fn(async () => ({})),
  ownerChanged: vi.fn(async () => {}),
  windowClosed: vi.fn(),
  dispose: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
  auth: { changed: () => {} },
}));
vi.mock('electron', () => ({
  app: { once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (
    _contract: unknown,
    handlers: Record<string, (event: unknown, ...args: unknown[]) => unknown>
  ) => {
    for (const [name, handler] of Object.entries(handlers)) boundary.handlers.set(name, handler);
    return () => boundary.handlers.clear();
  },
  sendRendererIpc: vi.fn(),
}));
vi.mock('../auth/controller', () => ({
  subscribeAuthState: (changed: () => void) => {
    boundary.auth.changed = changed;
    return () => {};
  },
}));
vi.mock('../google-sheets/native', () => ({ createNativeGoogleSheetsController: () => boundary }));
function handler(name: string) {
  const found = boundary.handlers.get(name);
  if (!found) throw new Error('Missing handler');
  return found;
}
function sender(url = 'http://localhost:5173/', frameMatches = true) {
  const frame = { url };
  return {
    sender: { id: 10, mainFrame: frame, isDestroyed: () => false, once: vi.fn() },
    senderFrame: frameMatches ? frame : { url },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.handlers.clear();
  registerGoogleSheetsHandlers({ trustedRendererUrl: () => 'http://localhost:5173/' });
});
describe('native Google Sheets IPC boundary', () => {
  it('binds requests to the current launch main frame and refuses arbitrary loopback origins', async () => {
    expect(() => handler('status')(sender('http://localhost:8999/'))).toThrow('Untrusted');
    expect(() => handler('status')(sender('https://accounts.google.com/'))).toThrow('Untrusted');
    expect(() => handler('status')(sender(undefined, false))).toThrow('Untrusted');
    expect(boundary.status).not.toHaveBeenCalled();
    await handler('status')(sender());
    expect(boundary.status).toHaveBeenCalledOnce();
  });
  it('validates grants and selected sheet identifiers before native reads', async () => {
    expect(() =>
      handler('worksheet')(sender(), { grantId: '../secret', spreadsheetId: 'abc', sheetId: 0 })
    ).toThrow();
    expect(() =>
      handler('worksheet')(sender(), {
        grantId: 'd3febde2-eaef-4a24-acdd-9c3c4f3675bf',
        spreadsheetId: 'abc',
        sheetId: -1,
      })
    ).toThrow();
    expect(boundary.worksheet).not.toHaveBeenCalled();
    const request = {
      grantId: 'd3febde2-eaef-4a24-acdd-9c3c4f3675bf',
      spreadsheetId: 'abc',
      sheetId: 0,
    };
    await handler('worksheet')(sender(), request);
    expect(boundary.worksheet).toHaveBeenCalledWith(request);
  });
  it('binds connect/cancel to the requesting contents and observes native auth changes', async () => {
    const event = sender();
    await handler('connect')(event);
    expect(boundary.start).toHaveBeenCalledWith(10);
    handler('cancel')(event, 'd3febde2-eaef-4a24-acdd-9c3c4f3675bf');
    expect(boundary.cancel).toHaveBeenCalledWith('d3febde2-eaef-4a24-acdd-9c3c4f3675bf', 10);
    boundary.auth.changed();
    expect(boundary.ownerChanged).toHaveBeenCalledOnce();
    expect(event.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
  });
});
