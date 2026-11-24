import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { AiOnlyOutputBoundary } from './AiOnlyWorkbench';

it('keeps an existing notebook editor writable by programmatic operations while its output is inert', () => {
  const editor = new Editor({ extensions: [StarterKit], content: '<p>Initial observation</p>' });
  const mounted = render(
    <AiOnlyOutputBoundary conversation={false}>
      <div data-testid="notebook-host" />
    </AiOnlyOutputBoundary>
  );
  const host = screen.getByTestId('notebook-host');
  host.append(editor.view.dom);
  try {
    expect(host.parentElement?.inert).toBe(true);
    expect(editor.isEditable).toBe(true);
    act(() => {
      editor.commands.setContent('<p>Agent updated observation</p>');
    });
    expect(screen.getByText('Agent updated observation')).toBeTruthy();
    expect(host.parentElement?.inert).toBe(true);
    mounted.rerender(
      <AiOnlyOutputBoundary conversation>
        <div data-testid="conversation" />
      </AiOnlyOutputBoundary>
    );
    expect(screen.getByTestId('conversation').parentElement?.inert).toBe(false);
  } finally {
    editor.destroy();
    mounted.unmount();
  }
});
