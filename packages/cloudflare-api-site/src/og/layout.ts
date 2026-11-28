// Ported from cloudflare/cloudflare-docs worker/og/layout.ts (MIT).
import type { OgCard } from './card.ts';
import type { Measure, TitleFont } from './fonts.ts';

type Style = Record<string, string | number>;
type Child = CardNode | string;
export interface CardNode {
  type: string;
  props: { style?: Style; children?: Child | Child[]; [attr: string]: unknown };
}

export const el = (style: Style, children?: Child | Child[]): CardNode => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
});

const INK = '#292929';
const DASH = '#cccccc';
const MONO = 'IBM Plex Mono';

const KUNST_GLYPHS = /^[ "'()+,\-.0-9:;A-Z`a-zÀ-ÖØ-öø-ſ]*$/;
const fontFor = (text: string): TitleFont => (KUNST_GLYPHS.test(text) ? 'FT Kunst Grotesk' : 'Inter');

export const M = 96;
const CONTENT_WIDTH = 1008;
const TITLE_WIDTH = 1000;
const TRACKING = -0.02;
const ELLIPSIS = '…';

export interface TitleScale {
  steps: readonly [number, number];
  tiers: readonly { fontSize: number; lineHeight: number; maxLines: number }[];
}

export const TITLE_SCALE: TitleScale = {
  steps: [45, 85],
  tiers: [
    { fontSize: 76, lineHeight: 1.1, maxLines: 2 },
    { fontSize: 60, lineHeight: 1.16, maxLines: 2 },
    { fontSize: 54, lineHeight: 1.18, maxLines: 3 },
  ],
};

const LOGO_SVG =
  '<svg width="66" height="30" viewBox="0 0 341 156" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M275.125 68.25C311.507 68.25 341 97.9335 341 134.55C341 141.077 340.063 147.385 338.317 153.343C337.848 154.943 336.363 156 334.706 156H243.056C241.697 156 240.76 154.628 241.247 153.351L242.999 148.76C248.595 134.03 264.56 121.963 279.331 121.256L307.33 119.813C308.826 119.736 310 118.492 310 116.985C310 115.485 308.838 114.245 307.351 114.157L281.059 112.601C266.924 111.877 260.018 99.2932 263.82 86.179L268.195 71.0866C268.64 69.5514 269.971 68.4343 271.557 68.3476C272.738 68.2831 273.928 68.25 275.125 68.25Z" fill="#FF9910"/>' +
  '<path d="M184.062 0C222 0 253.868 26.1297 262.882 61.4824C263.26 62.967 263.142 64.5333 262.601 65.9662L255.383 85.0897C249.787 99.8196 235.406 112.593 219.134 112.593L93.7928 114.043C92.2801 114.061 91.063 115.3 91.0625 116.823C91.0625 118.344 92.2776 119.585 93.789 119.605L217.365 121.248C231.531 121.248 238.406 134.556 234.606 147.671L233.011 153.189C232.53 154.855 231.014 156 229.291 156H3.90889C1.98075 156 0.330745 154.574 0.17634 152.64C0.0594555 151.175 0 149.695 0 148.2C0 119.723 21.6617 96.3403 49.306 93.8266C48.7387 91.2419 48.4375 88.5564 48.4375 85.8C48.4375 65.3379 64.919 48.75 85.25 48.75C93.3413 48.75 100.822 51.3789 106.897 55.8321C117.716 23.3806 148.176 0 184.062 0Z" fill="#FF5F08"/>' +
  '</svg>';

function tierMetrics(fontSize: number, measure: Measure) {
  const wordWidth = (text: string) => measure(text, fontFor(text), fontSize) + text.length * TRACKING * fontSize;
  const space = wordWidth(' ');
  const lineWidth = (line: string[]) =>
    line.reduce((width, text) => width + wordWidth(text), 0) + (line.length - 1) * space;
  return { wordWidth, lineWidth, space };
}

function wrap(words: string[], lineWidth: (line: string[]) => number) {
  const lines: string[][] = [];
  for (const text of words) {
    const line = lines[lines.length - 1];
    if (line && lineWidth([...line, text]) <= TITLE_WIDTH) line.push(text);
    else lines.push([text]);
  }
  return lines;
}

export function layoutTitle(raw: string, measure: Measure, scale: TitleScale = TITLE_SCALE) {
  const title = raw.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const [short, long] = scale.steps;
  const start = title.length > long ? 2 : title.length > short ? 1 : 0;
  const smallest = scale.tiers[scale.tiers.length - 1]!;
  const words = title
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const { wordWidth } = tierMetrics(smallest.fontSize, measure);
      if (wordWidth(word) <= TITLE_WIDTH) return word;
      let kept = word;
      while (kept.length > 1 && wordWidth(kept + ELLIPSIS) > TITLE_WIDTH) kept = kept.slice(0, -1);
      return kept + ELLIPSIS;
    });

  for (const tier of scale.tiers.slice(start)) {
    const { lineWidth, space } = tierMetrics(tier.fontSize, measure);
    const lines = wrap(words, lineWidth);
    if (lines.length <= tier.maxLines && lines.every((line) => lineWidth(line) <= TITLE_WIDTH)) {
      return { ...tier, lines, space, truncated: false };
    }
  }

  const { wordWidth, lineWidth, space } = tierMetrics(smallest.fontSize, measure);
  const kept = wrap(words, lineWidth).slice(0, smallest.maxLines);
  const last = kept[kept.length - 1]!;
  while (last.length > 1 && lineWidth(last) + wordWidth(ELLIPSIS) > TITLE_WIDTH) last.pop();
  return { ...smallest, lines: kept, space, truncated: true };
}

type TitleFit = ReturnType<typeof layoutTitle>;

function titleLine(line: string[], ellipsis: boolean, space: number) {
  const runs: { font: TitleFont; text: string }[] = [];
  for (const text of line) {
    const run = runs[runs.length - 1];
    if (run?.font === fontFor(text)) run.text += ` ${text}`;
    else runs.push({ font: fontFor(text), text });
  }
  if (ellipsis) runs.push({ font: fontFor(ELLIPSIS), text: ELLIPSIS });

  return el(
    { whiteSpace: 'nowrap' },
    runs.map((run, i) =>
      el(
        {
          flexShrink: 0,
          fontFamily: run.font,
          marginRight: i < runs.length - 1 && !(ellipsis && i === runs.length - 2) ? space : 0,
        },
        run.text,
      ),
    ),
  );
}

const PIN: Style = {
  position: 'absolute',
  width: 10,
  height: 10,
  background: '#fff',
  border: '1.25px solid #c9c9c9',
  borderRadius: 2,
};

const dashes = (direction: 'horizontal' | 'vertical', style: Style) =>
  el({
    position: 'absolute',
    ...(direction === 'horizontal'
      ? {
          height: 1.5,
          backgroundImage: `linear-gradient(90deg, ${DASH} 55%, transparent 45%)`,
          backgroundSize: '8px 1.5px',
        }
      : {
          width: 1.5,
          backgroundImage: `linear-gradient(180deg, ${DASH} 55%, transparent 45%)`,
          backgroundSize: '1.5px 8px',
        }),
    ...style,
  });

const FRAME = [
  ...[40, 1160].map((x) => dashes('vertical', { top: 0, bottom: 0, left: x })),
  ...[40, 590].map((y) => dashes('horizontal', { left: 0, right: 0, top: y })),
  ...[40, 1160].flatMap((x) => [40.75, 590.75].map((y) => el({ ...PIN, left: x - 5, top: y - 5 }))),
];

export const canvas = (children: CardNode[]) =>
  el({ position: 'relative', width: 1200, height: 630, background: '#fff' }, [
    ...FRAME,
    el({ position: 'absolute', top: M, left: M }, [
      { type: 'img', props: { src: `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`, width: 66, height: 30 } },
    ]),
    ...children,
  ]);

export const titleBand = (fit: TitleFit, height: number) =>
  el({ position: 'absolute', top: 140, left: M, right: M, height, flexDirection: 'column', justifyContent: 'center' }, [
    el(
      {
        flexDirection: 'column',
        maxWidth: TITLE_WIDTH,
        fontSize: fit.fontSize,
        lineHeight: fit.lineHeight,
        fontWeight: 500,
        letterSpacing: `${TRACKING}em`,
        color: INK,
      },
      fit.lines.map((line, i) => titleLine(line, fit.truncated && i === fit.lines.length - 1, fit.space)),
    ),
  ]);

export const dimensionLine = (top: number) =>
  el({ position: 'absolute', top, left: M, width: CONTENT_WIDTH, height: 10 }, [
    dashes('horizontal', { left: 0, right: 0, top: 4 }),
    el({ ...PIN, left: -5, top: 0 }),
    el({ ...PIN, right: -5, top: 0 }),
  ]);

const PILL = { fontSize: 24, tracking: 0.12, chrome: 26 * 2 + 1.5 * 2 };
const PILL_GAP = 12;

export function fitPills(labels: string[], measure: Measure) {
  const width = (label: string) => {
    const text = label.toUpperCase();
    return measure(text, MONO, PILL.fontSize) + text.length * PILL.tracking * PILL.fontSize + PILL.chrome;
  };
  const kept: string[] = [];
  let used = 0;
  for (const label of labels) {
    const gap = kept.length ? PILL_GAP : 0;
    if (used + gap + width(label) <= CONTENT_WIDTH) {
      kept.push(label);
      used += gap + width(label);
    } else if (!kept.length) {
      let text = label;
      while (text.length > 1 && width(text + ELLIPSIS) > CONTENT_WIDTH) text = text.slice(0, -1);
      return [text + ELLIPSIS];
    } else break;
  }
  return kept;
}

export const pillRow = (labels: string[]) =>
  el(
    { position: 'absolute', bottom: 120, left: M, gap: PILL_GAP },
    labels.map((label) =>
      el(
        {
          fontFamily: MONO,
          fontWeight: 500,
          lineHeight: 1,
          textTransform: 'uppercase',
          padding: '15px 26px',
          background: '#fff',
          border: '1.5px solid #d4d4d4',
          borderRadius: 999,
          fontSize: 24,
          letterSpacing: '0.12em',
          color: INK,
        },
        label,
      ),
    ),
  );

const METHOD: Record<string, { ink: string; tint: string; line: string }> = {
  get: { ink: '#006121', tint: '#ecf7ef', line: '#00996640' },
  post: { ink: '#0050b5', tint: '#edf4fe', line: '#00a6f440' },
  put: { ink: '#944500', tint: '#fef3e7', line: '#fa890040' },
  delete: { ink: '#a9131f', tint: '#fef0ee', line: '#fb2c3640' },
};
const methodKey = (verb: string) => {
  const v = verb.toLowerCase();
  return v === 'patch' ? 'put' : v in METHOD ? v : 'get';
};

function arrow(verb: string, color: string) {
  const v = methodKey(verb);
  const paths =
    v === 'get'
      ? ['M17 7 7 17', 'M17 17H7V7']
      : v === 'delete'
        ? ['M18 6 6 18', 'm6 6 12 12']
        : ['M7 7h10v10', 'M7 17 17 7'];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
  return { type: 'img', props: { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, width: 28, height: 28 } };
}

const CARD_TOP = 420;
const CARD_HEIGHT = 84;
const CARD_LINE = '#e5e5e5';

export function endpointCard(code: string, method?: string) {
  const c = method ? METHOD[methodKey(method)]! : undefined;
  return el(
    {
      position: 'absolute',
      top: CARD_TOP,
      left: M,
      width: CONTENT_WIDTH,
      height: CARD_HEIGHT,
      alignItems: 'stretch',
      padding: 4,
      borderRadius: 16,
      background: '#f7f7f7',
      border: `2px solid ${CARD_LINE}`,
    },
    [
      ...(method && c
        ? [
            el({ alignItems: 'center', padding: '0 24px 0 14px', flexShrink: 0 }, [
              el(
                {
                  width: 48,
                  height: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 11,
                  background: c.tint,
                  border: `2px solid ${c.line}`,
                },
                [arrow(method, c.ink)],
              ),
              el(
                { marginLeft: 14, fontFamily: MONO, fontWeight: 500, fontSize: 30, lineHeight: 1, color: c.ink },
                method.toUpperCase(),
              ),
            ]),
          ]
        : []),
      el(
        {
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          minWidth: 0,
          alignItems: 'center',
          padding: '0 26px',
          background: '#fff',
          borderRadius: 12,
          border: `2px solid ${CARD_LINE}`,
          overflow: 'hidden',
        },
        [
          el(
            {
              display: 'block',
              width: '100%',
              fontFamily: MONO,
              fontWeight: 500,
              fontSize: 30,
              lineHeight: 1.5,
              color: INK,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
            code,
          ),
        ],
      ),
    ],
  );
}

export function cardElement(card: OgCard, measure: Measure): CardNode {
  const title = layoutTitle(card.title, measure);
  if (card.code) {
    return canvas([titleBand(title, 228), dimensionLine(384), endpointCard(card.code, card.method)]);
  }
  const pills = fitPills(card.pills ?? [], measure);
  return canvas([titleBand(title, 260), dimensionLine(415), ...(pills.length ? [pillRow(pills)] : [])]);
}
