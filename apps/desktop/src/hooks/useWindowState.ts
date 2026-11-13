import { useEffect, useRef } from 'react';
import { platform } from '../platform';

const STORAGE_KEY = 'waypoint-window-state';
const DEBOUNCE_MS = 500;

interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

export function useWindowState() {
  const debounceTimer = useRef<number | null>(null);

  useEffect(() => {
    const p = platform();

    async function init() {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const state: WindowState = JSON.parse(saved);
          if (state.maximized) {
            await p.window.maximize();
          } else {
            await p.window.setSize(state.width, state.height);
            await p.window.setPosition(state.x, state.y);
          }
        } catch {}
      }
    }

    const saveState = async () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      debounceTimer.current = window.setTimeout(async () => {
        try {
          const size = await p.window.getSize();
          const position = await p.window.getPosition();
          const maximized = await p.window.isMaximized();
          const state: WindowState = {
            width: size.width,
            height: size.height,
            x: position.x,
            y: position.y,
            maximized,
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {}
      }, DEBOUNCE_MS);
    };

    const unsubResize = p.on('window:resize', saveState);
    const unsubMove = p.on('window:move', saveState);

    init();

    return () => {
      unsubResize();
      unsubMove();
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);
}
