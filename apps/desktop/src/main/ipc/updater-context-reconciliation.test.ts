import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function contextAccepted(reconcile: () => void, feedback: () => void): () => void {
  const source = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const registration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'registerAllIpcHandlers'
  );
  if (!registration?.body) throw new Error('IPC registration is missing');
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'registerAnalyticsHandlers'
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(registration.body);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error('Analytics registration is missing');
  const text = ts.createPrinter().printNode(ts.EmitHint.Expression, call, source);
  const javascript = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const database = {};
  const getAuthState = () => ({ status: 'signed-out' });
  let accepted: (() => void) | undefined;
  runInNewContext(javascript, {
    getAuthState,
    getDb: () => database,
    reconcileUpdateInstallTelemetryReceipt: (actual: unknown) => {
      expect(actual).toBe(database);
      reconcile();
    },
    recoverFeedbackTelemetry: feedback,
    registerAnalyticsHandlers: (auth: unknown, callback: () => void) => {
      expect(auth).toBe(getAuthState);
      accepted = callback;
    },
  });
  if (!accepted) throw new Error('Context-accepted callback is missing');
  return accepted;
}

describe('updater receipt recovery after actual IPC context acceptance', () => {
  it('reconciles the updater on the real database before preserving feedback recovery', () => {
    const order: string[] = [];
    const accepted = contextAccepted(
      () => order.push('updater'),
      () => order.push('feedback')
    );
    accepted();
    expect(order).toEqual(['updater', 'feedback']);
  });

  it.each([null, undefined, false, 0, '', new Error('updater recovery failed')])(
    'preserves feedback recovery and the exact updater failure %s',
    (failure) => {
      const order: string[] = [];
      const accepted = contextAccepted(
        () => {
          order.push('updater');
          throw failure;
        },
        () => order.push('feedback')
      );
      let rejected = false;
      try {
        accepted();
      } catch (actual) {
        rejected = true;
        expect(actual).toBe(failure);
      }
      expect(rejected).toBe(true);
      expect(order).toEqual(['updater', 'feedback']);
    }
  );
});
