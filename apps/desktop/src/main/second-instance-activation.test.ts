import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
let callback: string | undefined;
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(parsed) === 'app.on' &&
    node.arguments[0]?.getText(parsed) === "'second-instance'"
  )
    callback = node.arguments[1].getText(parsed);
  ts.forEachChild(node, visit);
}
visit(parsed);
if (!callback) throw new Error('Production second-instance handler is missing');
const javascript = ts.transpileModule(`globalThis.handler = ${callback}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(platform: string) {
  const focus = vi.fn();
  const paths = vi.fn();
  const protocol = vi.fn();
  const context = {
    process: { platform },
    requestsManagedRuntime: () => false,
    MCP_LAUNCH_ARG: '--launched-by=mcp',
    findMainFeatureProtocolUrlInArgv: () => undefined,
    findCallbackUrlInArgv: () => undefined,
    extractAssociationPathsFromArgv: () => [],
    routeProtocolUrl: protocol,
    routeAssociationPaths: paths,
    focusMainWindow: focus,
    handler: (_event: object, _argv: string[], _cwd: string): void => {
      throw new Error('Production callback was not evaluated');
    },
  };
  runInNewContext(javascript, context);
  return { ...context, focus, paths, protocol };
}

describe('production second-instance activation callback', () => {
  it('does not treat a bare macOS process reconnect as a request to take focus', () => {
    const { handler, focus } = fixture('darwin');
    for (let attempt = 0; attempt < 3; attempt++) handler({}, ['dnaforge'], '/tmp');
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'])('preserves normal user relaunch activation on %s', (platform) => {
    const { handler, focus } = fixture(platform);
    handler({}, ['dnaforge'], '/tmp');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each(['darwin', 'linux', 'win32'])('ignores MCP reconnects on %s', (platform) => {
    const { handler, focus, paths, protocol } = fixture(platform);
    handler({}, ['dnaforge', '--launched-by=mcp'], '/tmp');
    expect(focus).not.toHaveBeenCalled();
    expect(paths).not.toHaveBeenCalled();
    expect(protocol).not.toHaveBeenCalled();
  });
});
