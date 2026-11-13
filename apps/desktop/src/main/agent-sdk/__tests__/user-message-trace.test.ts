import { expect, it } from 'vitest';
import { userMessage } from '@waypoint/user-messages';
import { CodexTraceAdapter, ClaudeTraceAdapter } from '../trace-adapter';

const versions = { sdkVersion: 'test', cliVersion: 'test' };
const leaks = [
  'platform.trackViews.list is not available in the hosted browser runtime.',
  'UCSC tracks: VITE_API_URL is not set',
];

it.each(leaks)('keeps provider failure out of the public trace: %s', (message) => {
  const event = new CodexTraceAdapter(versions).adapt({ type: 'turn.failed', error: { message } });
  expect(event.display.text).toBe(userMessage('assistant.failed'));
  expect(event.raw).toMatchObject({ error: { message } });
});

it.each(leaks)('does not treat a failed provider result as an assistant answer: %s', (result) => {
  const adapter = new ClaudeTraceAdapter(versions);
  const event = adapter.adapt({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result,
  });
  expect(adapter.extractFinalText([event])).not.toContain(result);
  expect(event.raw).toMatchObject({ result });
});
