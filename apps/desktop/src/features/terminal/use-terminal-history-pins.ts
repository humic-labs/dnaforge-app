import { userMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { parseTerminalHistoryPins } from './terminal-history-picker';

function readPins(key: string): string[] {
  try {
    return parseTerminalHistoryPins(localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function useTerminalHistoryPins(key: string) {
  const [pins, setPins] = useState(() => readPins(key));
  const [error, setError] = useState('');
  useEffect(() => {
    setPins(readPins(key));
    const changed = (event: StorageEvent) => {
      if (event.key === key) setPins(parseTerminalHistoryPins(event.newValue));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key]);
  const toggle = (text: string) => {
    const current = readPins(key);
    const next = current.includes(text)
      ? current.filter((item) => item !== text)
      : [...current, text].slice(-100);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setPins(next);
      setError('');
    } catch {
      setError(userMessage('failure.pinned-history-could-not-be-saved'));
    }
  };
  return { pins, toggle, error };
}
