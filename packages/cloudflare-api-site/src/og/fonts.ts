import plexMonoUrl from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff?inline';
import interUrl from '@fontsource/inter/files/inter-latin-500-normal.woff?inline';
import { parse, type Font } from 'opentype.js';

export type TitleFont = 'FT Kunst Grotesk' | 'Inter';
export type Measure = (text: string, font: TitleFont | 'IBM Plex Mono', fontSize: number) => number;

export interface FontBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

const bytes = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0)).buffer;

export const inter = bytes(interUrl);
const plexMono = bytes(plexMonoUrl);

export const KUNST_GROTESK_KEY = 'fonts/KunstGrotesk-Medium.ttf';

let kunstGrotesk: ArrayBuffer | undefined;

export async function loadTitleFont(bucket: FontBucket | undefined): Promise<ArrayBuffer> {
  if (kunstGrotesk) return kunstGrotesk;
  if (!bucket) return inter;
  try {
    const data = await (await bucket.get(KUNST_GROTESK_KEY))?.arrayBuffer();
    if (data) {
      face(data);
      kunstGrotesk = data;
      return data;
    }
    console.warn(`[og] ${KUNST_GROTESK_KEY} is missing from the private bucket; titles use Inter`);
  } catch (error) {
    console.warn(`[og] Could not load ${KUNST_GROTESK_KEY}; titles use Inter`, error);
  }
  return inter;
}

export const satoriFonts = (titleFont: ArrayBuffer) =>
  [
    { name: 'FT Kunst Grotesk', data: titleFont, weight: 500 as const },
    { name: 'Inter', data: inter, weight: 500 as const },
    { name: 'IBM Plex Mono', data: plexMono, weight: 500 as const },
  ].map((font) => ({ ...font, style: 'normal' as const }));

const faces = new WeakMap<ArrayBuffer, Font>();
function face(data: ArrayBuffer) {
  let font = faces.get(data);
  if (!font) faces.set(data, (font = parse(data)));
  return font;
}

export const measureWith =
  (titleFont: ArrayBuffer): Measure =>
  (text, font, fontSize) => {
    const metrics = face(font === 'Inter' ? inter : font === 'IBM Plex Mono' ? plexMono : titleFont);
    const glyphs = Array.from(text, (char) => metrics.charToGlyph(char));
    const units = glyphs.reduce(
      (width, glyph, i) => width + glyph.advanceWidth + (i > 0 ? metrics.getKerningValue(glyphs[i - 1]!, glyph) : 0),
      0,
    );
    return (units / metrics.unitsPerEm) * fontSize;
  };
