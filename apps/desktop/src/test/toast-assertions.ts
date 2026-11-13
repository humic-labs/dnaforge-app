import { expect } from 'vitest';
import { resolveToastDefinition, type ToastSelection } from '../stores/toast-definitions';

type ToastSpy = { mock: { calls: unknown[][] } };

export function normalizeToastCalls(spy: ToastSpy, arity = 2): unknown[][] {
  return spy.mock.calls.map((args) => {
    const first = args[0];
    if (first && typeof first === 'object' && 'definition' in first) {
      return [{ ...resolveToastDefinition(first as ToastSelection), ...first }];
    }
    const selection = args[1];
    if (selection && typeof selection === 'object' && 'definition' in selection) {
      const policy = resolveToastDefinition(selection as ToastSelection);
      return [first, policy.type, policy.duration].slice(0, arity);
    }
    return args;
  });
}
export function expectToastCall(spy: ToastSpy, ...expected: unknown[]): void {
  expect(normalizeToastCalls(spy, expected.length)).toEqual(expect.arrayContaining([expected]));
}
export function expectLastToastCall(spy: ToastSpy, ...expected: unknown[]): void {
  const calls = normalizeToastCalls(spy, expected.length);
  expect(calls[calls.length - 1]).toEqual(expected);
}
export function expectNoToastCall(spy: ToastSpy, ...expected: unknown[]): void {
  expect(normalizeToastCalls(spy, expected.length)).not.toEqual(expect.arrayContaining([expected]));
}
export function expectNthToastCall(spy: ToastSpy, index: number, ...expected: unknown[]): void {
  expect(normalizeToastCalls(spy, expected.length)[index - 1]).toEqual(expected);
}
