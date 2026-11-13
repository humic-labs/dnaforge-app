import type { CSSProperties, ReactNode } from 'react';
import './brand-wordmark-font.css';

export const DNAFORGE_WORDMARK_COLORS = {
  dna: '#1f7a4f',
  forge: '#fbbf24',
} as const;

export const DNAFORGE_WORDMARK_FONT_WEIGHT = 750;

export const DNAFORGE_WORDMARK_FONT_FAMILY =
  "'DNAForge Wordmark Mono', ui-monospace, 'Cascadia Code', 'Fira Code', monospace";

const dnaStyle = {
  color: DNAFORGE_WORDMARK_COLORS.dna,
  fontWeight: DNAFORGE_WORDMARK_FONT_WEIGHT,
  fontFamily: DNAFORGE_WORDMARK_FONT_FAMILY,
} satisfies CSSProperties;

const forgeStyle = {
  color: DNAFORGE_WORDMARK_COLORS.forge,
  fontWeight: DNAFORGE_WORDMARK_FONT_WEIGHT,
  fontFamily: DNAFORGE_WORDMARK_FONT_FAMILY,
} satisfies CSSProperties;

export function BrandDnaText({ children }: { children: ReactNode }) {
  return <span style={dnaStyle}>{children}</span>;
}

export function BrandForgeText({ children }: { children: ReactNode }) {
  return <span style={forgeStyle}>{children}</span>;
}

export function BrandWordmarkText() {
  return (
    <>
      <BrandDnaText>DNA</BrandDnaText>
      <BrandForgeText>FORGE</BrandForgeText>
    </>
  );
}
