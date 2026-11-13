import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { expect, it } from 'vitest';
import { TerminalGroupHost } from './TerminalGroupHost';

it('moves live contents between the panel and editor without remounting or losing input', () => {
  let mounts = 0;
  function Input() {
    const [text, setText] = useState('');
    useEffect(() => {
      mounts++;
    }, []);
    return (
      <input
        aria-label="live input"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }
  const editor = document.createElement('div');
  document.body.appendChild(editor);
  const view = render(
    <TerminalGroupHost visible>
      <Input />
    </TerminalGroupHost>
  );
  const original = screen.getByLabelText('live input');
  fireEvent.change(original, { target: { value: 'unfinished command' } });
  view.rerender(
    <TerminalGroupHost visible target={editor}>
      <Input />
    </TerminalGroupHost>
  );
  expect(editor.contains(original)).toBe(true);
  expect(screen.getByLabelText('live input')).toBe(original);
  view.rerender(
    <TerminalGroupHost visible>
      <Input />
    </TerminalGroupHost>
  );
  expect(editor.contains(original)).toBe(false);
  expect(screen.getByLabelText('live input')).toHaveValue('unfinished command');
  expect(mounts).toBe(1);
  view.unmount();
  editor.remove();
});
