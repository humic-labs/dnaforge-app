import { useState, useEffect, useCallback } from 'react';

export const SPINNER_WORDS = [
  'annealing',
  'ligating',
  'supercoiling',
  'priming',
  'translocating',
  'splicing',
  'denaturing',
  'refolding',
  'chaperoning',
  'dimerizing',
  'catalyzing',
  'digesting',
  'polymerizing',
  'hydrolyzing',
  'recombining',
  'transducing',
  'conjugating',
  'sporulating',
  'differentiating',
  'transfecting',
  'transforming',
  'fluorescing',
  'hybridizing',
  'vortexing',
  'quenching',
  'intercalating',
  'retrotransposing',
  'frameshifting',
  'topoisomerizing',
  'sonicating',
  'electrophoresing',
  'expressing',
  'unwinding',
  'replicating',
  'amplifying',
  'translating',
  'passaging',
  'inoculating',
  'propagating',
  'precipitating',
  'aspirating',
  'chelating',
  'scaffolding',
  'crosslinking',
  'permeabilizing',
  'assembling',
  'evolving',
  'multiplexing',
  'barcoding',
  'incubating',
];

export function pickRandomWord(exclude?: string): string {
  const pool = exclude ? SPINNER_WORDS.filter((w) => w !== exclude) : SPINNER_WORDS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function formatWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1) + '...';
}

export function useSpinnerWord(intervalMs = 2500): { word: string; visible: boolean } {
  const [current, setCurrent] = useState(() => pickRandomWord());
  const [visible, setVisible] = useState(true);

  const cycle = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      setCurrent((prev) => pickRandomWord(prev));
      setVisible(true);
    }, 200);
  }, []);

  useEffect(() => {
    const id = setInterval(cycle, intervalMs);
    return () => clearInterval(id);
  }, [cycle, intervalMs]);

  return { word: formatWord(current), visible };
}
