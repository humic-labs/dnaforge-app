import { describe, expect, it } from 'vitest';
import {
  createHostedSseDecoder,
  encodeHostedSseEvent,
  HOSTED_SSE_MAX_EVENT_COUNT,
  HOSTED_SSE_MAX_FRAME_BYTES,
  HOSTED_SSE_MAX_RESPONSE_BYTES,
  parseHostedSseEventFrame,
} from './sse.js';
import type { HostedStreamEvent } from './wire.js';

const accepted: HostedStreamEvent = {
  v: 2,
  seq: 0,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'accepted',
  reservationId: '33333333-3333-4333-8333-333333333333',
  tier: 'auto',
  catalogVersion: 'catalog-v1',
  rateCardVersion: 'rate-v1',
};

const delta: HostedStreamEvent = {
  v: 2,
  seq: 1,
  requestId: 'request-1',
  runId: 'run-1',
  turnId: 'turn-1',
  stepSequence: 0,
  event: 'text_delta',
  delta: 'hello\nworld',
};

describe('Hosted SSE framing', () => {
  it('encodes and parses a strict named SSE event', () => {
    const encoded = encodeHostedSseEvent(delta);
    expect(encoded).toContain('id: request-1:1\n');
    expect(encoded).toContain('event: text_delta\n');
    expect(parseHostedSseEventFrame(encoded)).toEqual(delta);
  });

  it('handles arbitrary chunk boundaries, CRLF, comments, and multiple frames', () => {
    const decoder = createHostedSseDecoder();
    const wire = `${encodeHostedSseEvent(accepted)}: keepalive\n\n${encodeHostedSseEvent(delta)}`
      .split('\n')
      .join('\r\n');
    const splitCrLf = wire.indexOf('\r\n') + 1;
    const pieces = [
      wire.slice(0, 7),
      wire.slice(7, splitCrLf),
      wire.slice(splitCrLf, 103),
      wire.slice(103),
    ];
    const decoded = pieces.flatMap((piece) => decoder.push(piece));
    decoded.push(...decoder.finish());
    expect(decoded).toEqual([accepted, delta]);
  });

  it('joins multiple data lines before decoding JSON', () => {
    const json = JSON.stringify(delta);
    const split = Math.floor(json.length / 2);
    const frame = `event: text_delta\ndata: ${json.slice(0, split)}\ndata: ${json.slice(split)}\n\n`;
    expect(() => parseHostedSseEventFrame(frame)).toThrow();
  });

  it('rejects an event-name mismatch and schema-invalid data', () => {
    expect(() =>
      parseHostedSseEventFrame(
        encodeHostedSseEvent(delta).replace('event: text_delta', 'event: finish')
      )
    ).toThrow(/mismatch/i);
    expect(() =>
      parseHostedSseEventFrame('event: text_delta\ndata: {"event":"text_delta","delta":"x"}\n\n')
    ).toThrow();
  });

  it('flushes one final non-blank frame and ignores comments or blank input', () => {
    const decoder = createHostedSseDecoder();
    expect(decoder.push(': keepalive\n\n')).toEqual([]);
    expect(decoder.push(encodeHostedSseEvent(delta).trimEnd())).toEqual([]);
    expect(decoder.finish()).toEqual([delta]);
    expect(decoder.finish()).toEqual([]);
  });

  it('publishes finite production limits for frames, aggregate responses, and events', () => {
    expect(HOSTED_SSE_MAX_FRAME_BYTES).toBe(2 * 1024 * 1024);
    expect(HOSTED_SSE_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    expect(HOSTED_SSE_MAX_EVENT_COUNT).toBe(65_536);
  });

  it('bounds UTF-8 frame bytes, including delimiter-free input', () => {
    const exact = createHostedSseDecoder({ maxFrameBytes: 9 });
    expect(exact.push(`:${'é'.repeat(4)}\n\n`)).toEqual([]);

    const completedOverflow = createHostedSseDecoder({ maxFrameBytes: 8 });
    expect(() => completedOverflow.push(`:${'é'.repeat(4)}\n\n`)).toThrow(/frame.*byte/i);

    const delimiterFreeOverflow = createHostedSseDecoder({ maxFrameBytes: 8 });
    expect(() => delimiterFreeOverflow.push('é'.repeat(5))).toThrow(/frame.*byte/i);
  });

  it('does not count a split frame delimiter against the exact frame limit', () => {
    const encoded = encodeHostedSseEvent(accepted);
    const frame = encoded.slice(0, -2);
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    const decoder = createHostedSseDecoder({ maxFrameBytes: frameBytes });
    expect(decoder.push(`${frame}\n`)).toEqual([]);
    expect(decoder.push('\n')).toEqual([accepted]);
  });

  it('rejects an event beyond the bounded event count', () => {
    const decoder = createHostedSseDecoder({ maxEventCount: 1 });
    expect(decoder.push(encodeHostedSseEvent(accepted))).toEqual([accepted]);
    expect(() => decoder.push(encodeHostedSseEvent(delta))).toThrow(/event count/i);
  });

  it('bounds aggregate UTF-8 response bytes across otherwise valid frames', () => {
    const frame = encodeHostedSseEvent(accepted);
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    const decoder = createHostedSseDecoder({ maxResponseBytes: frameBytes });
    expect(decoder.push(frame)).toEqual([accepted]);
    expect(() => decoder.push(':x\n\n')).toThrow(/response.*byte/i);
  });
});
