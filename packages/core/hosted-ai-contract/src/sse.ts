import { HostedStreamEventSchema, type HostedStreamEvent } from './wire.js';

export const HOSTED_SSE_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const HOSTED_SSE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const HOSTED_SSE_MAX_EVENT_COUNT = 65_536;

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function endsWithHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const codeUnit = value.charCodeAt(value.length - 1);
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function startsWithLowSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const codeUnit = value.charCodeAt(0);
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function encodeHostedSseEvent(event: HostedStreamEvent): string {
  const parsed = HostedStreamEventSchema.parse(event);
  return `id: ${parsed.requestId}:${parsed.seq}\nevent: ${parsed.event}\ndata: ${JSON.stringify(parsed)}\n\n`;
}

export function parseHostedSseEventFrame(frame: string): HostedStreamEvent | null {
  const dataLines: string[] = [];
  let declaredEvent: string | undefined;

  for (const rawLine of frame.split('\r\n').join('\n').split('\n')) {
    if (rawLine.startsWith(':') || rawLine.length === 0) continue;
    const separator = rawLine.indexOf(':');
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') declaredEvent = value;
    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  const event = HostedStreamEventSchema.parse(JSON.parse(dataLines.join('\n')));
  if (declaredEvent && declaredEvent !== event.event) {
    throw new Error(`SSE event mismatch: declared ${declaredEvent}, payload ${event.event}`);
  }
  return event;
}

export interface HostedSseDecoder {
  push(chunk: string): HostedStreamEvent[];
  finish(): HostedStreamEvent[];
}

export interface HostedSseDecoderLimits {
  readonly maxFrameBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxEventCount?: number;
}

function resolveLowerLimit(requested: number | undefined, ceiling: number, name: string): number {
  if (requested === undefined) return ceiling;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > ceiling) {
    throw new Error(`${name} must be a positive safe integer no greater than ${ceiling}`);
  }
  return requested;
}

function nextFrameBoundary(
  value: string
): { readonly index: number; readonly length: number } | null {
  const match = /(?:\r\n|\n)(?:\r\n|\n)/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function possibleBoundaryPrefixBytes(value: string): number {
  if (value.endsWith('\r\n\r')) return 3;
  if (value.endsWith('\r\n') || value.endsWith('\n\r')) return 2;
  if (value.endsWith('\n') || value.endsWith('\r')) return 1;
  return 0;
}

export function createHostedSseDecoder(limits: HostedSseDecoderLimits = {}): HostedSseDecoder {
  const maxFrameBytes = resolveLowerLimit(
    limits.maxFrameBytes,
    HOSTED_SSE_MAX_FRAME_BYTES,
    'maxFrameBytes'
  );
  const maxEventCount = resolveLowerLimit(
    limits.maxEventCount,
    HOSTED_SSE_MAX_EVENT_COUNT,
    'maxEventCount'
  );
  const maxResponseBytes = resolveLowerLimit(
    limits.maxResponseBytes,
    HOSTED_SSE_MAX_RESPONSE_BYTES,
    'maxResponseBytes'
  );
  let buffer = '';
  let bufferBytes = 0;
  let responseBytes = 0;
  let eventCount = 0;
  let failed = false;
  let streamEndedWithHighSurrogate = false;

  const fail = (message: string): never => {
    failed = true;
    buffer = '';
    bufferBytes = 0;
    throw new Error(message);
  };

  const parseFrame = (frame: string, frameBytes: number): HostedStreamEvent | null => {
    if (frameBytes > maxFrameBytes) {
      return fail(`Hosted SSE frame exceeds the ${maxFrameBytes} byte limit`);
    }
    const event = parseHostedSseEventFrame(frame);
    if (event && eventCount >= maxEventCount) {
      return fail(`Hosted SSE event count exceeds the ${maxEventCount} event limit`);
    }
    if (event) eventCount += 1;
    return event;
  };

  const takeFrames = (finish: boolean): HostedStreamEvent[] => {
    if (failed) throw new Error('Hosted SSE decoder is in a failed state');
    const events: HostedStreamEvent[] = [];
    let boundary = nextFrameBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      const frameBytes = utf8ByteLength(frame);
      buffer = buffer.slice(boundary.index + boundary.length);
      bufferBytes = utf8ByteLength(buffer);
      const event = parseFrame(frame, frameBytes);
      if (event) events.push(event);
      boundary = nextFrameBoundary(buffer);
    }
    if (finish && buffer.trim().length > 0) {
      const event = parseFrame(buffer, bufferBytes);
      buffer = '';
      bufferBytes = 0;
      if (event) events.push(event);
    } else if (finish) {
      buffer = '';
      bufferBytes = 0;
    } else if (bufferBytes - possibleBoundaryPrefixBytes(buffer) > maxFrameBytes) {
      fail(`Hosted SSE frame exceeds the ${maxFrameBytes} byte limit`);
    }
    return events;
  };

  return {
    push(chunk) {
      if (failed) throw new Error('Hosted SSE decoder is in a failed state');
      const joinsSurrogatePair = streamEndedWithHighSurrogate && startsWithLowSurrogate(chunk);
      responseBytes += utf8ByteLength(chunk) - (joinsSurrogatePair ? 2 : 0);
      if (responseBytes > maxResponseBytes) {
        fail(`Hosted SSE response exceeds the ${maxResponseBytes} byte limit`);
      }
      if (chunk.length > 0) streamEndedWithHighSurrogate = endsWithHighSurrogate(chunk);
      buffer += chunk;
      bufferBytes = utf8ByteLength(buffer);
      return takeFrames(false);
    },
    finish() {
      return takeFrames(true);
    },
  };
}
