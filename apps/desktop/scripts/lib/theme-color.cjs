'use strict';

const { readFileSync } = require('node:fs');

function readThemeColor(css, token) {
  const match = css.match(new RegExp(`${token}:\\s*([^;]+);`));
  if (!match) throw new Error(`missing ${token} in the desktop theme`);
  return parseColor(match[1].trim());
}

function parseColor(value) {
  const hsl = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (hsl) {
    return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
  }
  const hex = value.match(/^#([\da-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  throw new Error(`unsupported theme color ${value}`);
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return {
    r: Math.round(f(0) * 255),
    g: Math.round(f(8) * 255),
    b: Math.round(f(4) * 255),
  };
}

function rgbCss(color) {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

function mix(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function readDesktopTheme(stylesheetPath) {
  const css = readFileSync(stylesheetPath, 'utf8');
  return {
    green: readThemeColor(css, '--color-accent'),
    yellow: readThemeColor(css, '--color-warning'),
    background: readThemeColor(css, '--color-bg'),
    arrow: readThemeColor(css, '--color-fg'),
  };
}

module.exports = { readThemeColor, readDesktopTheme, rgbCss, mix };
