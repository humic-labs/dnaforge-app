import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  BrandDnaText,
  BrandForgeText,
  BrandWordmarkText,
  DNAFORGE_WORDMARK_COLORS,
  DNAFORGE_WORDMARK_FONT_FAMILY,
  DNAFORGE_WORDMARK_FONT_WEIGHT,
} from './BrandWordmark';

describe('BrandWordmark (desktop)', () => {
  it('pins the wordmark colors to the same brand palette as apps/web', () => {
    expect(DNAFORGE_WORDMARK_COLORS.dna).toBe('#1f7a4f');
    expect(DNAFORGE_WORDMARK_COLORS.forge).toBe('#fbbf24');
  });

  it('pins the wordmark font weight to match apps/web', () => {
    expect(DNAFORGE_WORDMARK_FONT_WEIGHT).toBe(750);
  });

  it('pins the wordmark font-family to the bundled JetBrains Mono typeface, under a private alias', () => {
    expect(DNAFORGE_WORDMARK_FONT_FAMILY).toContain('DNAForge Wordmark Mono');
  });

  it('never registers under the literal "JetBrains Mono" family name (would collide with genome-renderer sequence/cut-site text)', () => {
    expect(DNAFORGE_WORDMARK_FONT_FAMILY).not.toContain('JetBrains Mono');
  });

  it('renders DNA and FORGE with their pinned brand colors, weight, and font-family', () => {
    render(
      <>
        <BrandDnaText>DNA</BrandDnaText>
        <BrandForgeText>FORGE</BrandForgeText>
      </>
    );

    expect(screen.getByText('DNA')).toHaveStyle({
      color: '#1f7a4f',
      fontWeight: '750',
      fontFamily: DNAFORGE_WORDMARK_FONT_FAMILY,
    });
    expect(screen.getByText('FORGE')).toHaveStyle({
      color: '#fbbf24',
      fontWeight: '750',
      fontFamily: DNAFORGE_WORDMARK_FONT_FAMILY,
    });
  });

  it('renders the canonical two-word wordmark via BrandWordmarkText', () => {
    render(<BrandWordmarkText />);
    expect(screen.getByText('DNA')).toBeInTheDocument();
    expect(screen.getByText('FORGE')).toBeInTheDocument();
  });
});
