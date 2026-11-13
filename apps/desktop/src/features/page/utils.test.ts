// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractTitle, formatRelativeTime } from './utils';
import type { JSONContent } from '@tiptap/core';

describe('extractTitle', () => {
  it('returns null for empty content', () => {
    const content: JSONContent = { type: 'doc', content: [] };
    expect(extractTitle(content)).toBeNull();
  });

  it('returns null for content with no nodes', () => {
    const content: JSONContent = { type: 'doc' };
    expect(extractTitle(content)).toBeNull();
  });

  it('extracts title from heading', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'My Document Title' }],
        },
      ],
    };
    expect(extractTitle(content)).toBe('My Document Title');
  });

  it('extracts title from paragraph', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'First paragraph text' }],
        },
      ],
    };
    expect(extractTitle(content)).toBe('First paragraph text');
  });

  it('truncates paragraph text to 50 characters', () => {
    const longText =
      'This is a very long paragraph that exceeds fifty characters and should be truncated';
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: longText }],
        },
      ],
    };
    expect(extractTitle(content)).toBe(longText.slice(0, 50));
    expect(extractTitle(content)?.length).toBe(50);
  });

  it('returns null for heading with no text', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [],
        },
      ],
    };
    expect(extractTitle(content)).toBeNull();
  });

  it('returns null for empty paragraph', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [],
        },
      ],
    };
    expect(extractTitle(content)).toBeNull();
  });

  it('returns null for other node types as first node', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'List item' }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractTitle(content)).toBeNull();
  });

  it('uses first heading even if there are multiple nodes', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Main Title' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Some paragraph' }],
        },
      ],
    };
    expect(extractTitle(content)).toBe('Main Title');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for times less than 10 seconds ago', () => {
    const now = new Date('2024-01-01T12:00:00');
    vi.setSystemTime(now);

    const fiveSecondsAgo = new Date('2024-01-01T11:59:55');
    expect(formatRelativeTime(fiveSecondsAgo)).toBe('just now');

    const nineSecondsAgo = new Date('2024-01-01T11:59:51');
    expect(formatRelativeTime(nineSecondsAgo)).toBe('just now');
  });

  it('returns seconds for times 10-59 seconds ago', () => {
    const now = new Date('2024-01-01T12:00:00');
    vi.setSystemTime(now);

    const tenSecondsAgo = new Date('2024-01-01T11:59:50');
    expect(formatRelativeTime(tenSecondsAgo)).toBe('10s ago');

    const thirtySecondsAgo = new Date('2024-01-01T11:59:30');
    expect(formatRelativeTime(thirtySecondsAgo)).toBe('30s ago');
  });

  it('returns minutes for times 1-59 minutes ago', () => {
    const now = new Date('2024-01-01T12:00:00');
    vi.setSystemTime(now);

    const oneMinuteAgo = new Date('2024-01-01T11:59:00');
    expect(formatRelativeTime(oneMinuteAgo)).toBe('1m ago');

    const thirtyMinutesAgo = new Date('2024-01-01T11:30:00');
    expect(formatRelativeTime(thirtyMinutesAgo)).toBe('30m ago');
  });

  it('returns hours for times 1-23 hours ago', () => {
    const now = new Date('2024-01-01T12:00:00');
    vi.setSystemTime(now);

    const oneHourAgo = new Date('2024-01-01T11:00:00');
    expect(formatRelativeTime(oneHourAgo)).toBe('1h ago');

    const twelveHoursAgo = new Date('2024-01-01T00:00:00');
    expect(formatRelativeTime(twelveHoursAgo)).toBe('12h ago');
  });

  it('returns date string for times 24+ hours ago', () => {
    const now = new Date('2024-01-02T12:00:00');
    vi.setSystemTime(now);

    const yesterday = new Date('2024-01-01T12:00:00');
    expect(formatRelativeTime(yesterday)).toBe(yesterday.toLocaleDateString());
  });
});
