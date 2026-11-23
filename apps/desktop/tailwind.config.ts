import { menuDensityVariables } from '@waypoint/ui-components/menu-density';
import plugin from 'tailwindcss/plugin';
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/components/src/**/*.{ts,tsx}',
    '../../packages/core/*/src/**/*.{ts,tsx}',
    '../../packages/features/*/src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'hsl(var(--color-bg) / <alpha-value>)',
        'bg-subtle': 'hsl(var(--color-bg-subtle) / <alpha-value>)',
        'bg-muted': 'hsl(var(--color-bg-muted) / <alpha-value>)',
        fg: 'hsl(var(--color-fg) / <alpha-value>)',
        'fg-muted': 'hsl(var(--color-fg-muted) / <alpha-value>)',
        'fg-subtle': 'hsl(var(--color-fg-subtle) / <alpha-value>)',
        border: 'hsl(var(--color-border) / <alpha-value>)',
        'border-hover': 'hsl(var(--color-border-hover) / <alpha-value>)',
        accent: 'hsl(var(--color-accent) / <alpha-value>)',
        'accent-subtle': 'hsl(var(--color-accent-subtle) / <alpha-value>)',
        'accent-fg': 'hsl(var(--color-accent-fg) / <alpha-value>)',
        success: 'hsl(var(--color-success) / <alpha-value>)',
        'oligo-special': 'hsl(var(--color-oligo-special) / <alpha-value>)',
        warning: 'hsl(var(--color-warning) / <alpha-value>)',
        error: 'hsl(var(--color-error) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        xs: 'var(--text-xs)',
        sm: 'var(--text-sm)',
        base: 'var(--text-base)',
        lg: 'var(--text-lg)',
      },
      spacing: {
        sidebar: 'var(--sidebar-width)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
      },
    },
  },
  plugins: [
    plugin(({ addComponents }) =>
      addComponents({
        '.canvas-tab-strip-scroll': {
          '&[data-sliding] > .tab-shell': {
            transform: 'translateX(var(--tab-slide-x, 0px))',
            transition: 'transform 140ms ease-out',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          },
          '&[data-sliding] > [data-grabbed]': {
            zIndex: '20',
            backgroundColor: 'hsl(var(--color-bg))',
            borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
            transition: 'none',
          },
          '& > .tab-shell[data-grabbed] > .tab-inner': { opacity: '1' },
        },
      })
    ),
    plugin(({ addUtilities }) => addUtilities({ '.wp-form-density': menuDensityVariables('form') })),
  ],
};

export default config;
