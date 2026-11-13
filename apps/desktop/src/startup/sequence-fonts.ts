import {
  configureSequenceFonts,
  JETBRAINS_MONO_FONT_NAME,
  loadSequenceFonts,
  type SequenceFontSources,
} from '@waypoint/platform';
import regular from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import medium from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url';
import semibold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url';
import bold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url';

let ready: Promise<void> | undefined;

export function prepareSequenceFonts(): Promise<void> {
  if (!ready) {
    const source = (asset: string) =>
      `url("${new URL(asset, window.location.href).href}") format("woff2")`;
    const sources: SequenceFontSources = {
      400: source(regular),
      500: source(medium),
      600: source(semibold),
      700: source(bold),
    };
    configureSequenceFonts(sources);
    ready = loadSequenceFonts(
      document.fonts,
      sources,
      (source, weight) =>
        new FontFace(JETBRAINS_MONO_FONT_NAME, source, { weight, style: 'normal' })
    ).catch((cause) => {
      console.error('[Sequence fonts] Bundled font loading failed', cause);
      throw new Error(
        'The sequence display font could not load. Reload the application to try again.'
      );
    });
  }
  return ready;
}
