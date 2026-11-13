'use strict';

const windowSize = { width: 400, height: 232 };
const iconSize = 84;
const iconTextSize = 12;

const app = { x: 98, y: 94 };
const applications = { x: 302, y: 94 };

function builderDmg() {
  return {
    sign: true,
    background: 'dmg-background.png',
    iconSize,
    iconTextSize,
    window: { width: windowSize.width, height: windowSize.height },
    contents: [
      { x: app.x, y: app.y, type: 'file' },
      { x: applications.x, y: applications.y, type: 'link', path: '/Applications' },
    ],
  };
}

module.exports = {
  windowSize,
  iconSize,
  iconTextSize,
  app,
  applications,
  backgroundFile: 'dmg-background.png',
  themeStylesheet: 'src/index.css',
  backgroundTint: 0.16,
  themeTokens: {
    green: '--color-accent',
    yellow: '--color-warning',
    background: '--color-bg',
    arrow: '--color-fg',
  },
  builderDmg,
};
