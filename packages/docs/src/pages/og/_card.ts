/**
 * The site's social cards, 1200 × 630 PNGs rendered at build time in the
 * developers.cloudflare.com card design. `og/[...slug].ts` draws one per page
 * and `og.png.ts` the site's own. The leading underscore keeps Astro from
 * routing this file or `_fonts/`.
 */
import { readFile } from "node:fs/promises";

import { createCardRenderer, type CardFont, type CardNode, type CardTypography } from "@cloudflare/nimbus-docs/og";
import { root } from "astro:config/server";

import { logo } from "@/components/logo";

const INK = "#292929";
const DASH = "#cccccc";
const M = 96;
const TITLE_WIDTH = 1000;
const CONTENT_WIDTH = 1008;

const FONT_BUCKET = "api-docs-private";
const FONT_KEY = "fonts/KunstGrotesk-Medium.ttf";

// Fonts sit beside this file, not in public/, so they never ship. Read from
// the project so `astro build --root <site>` finds them.
const font = (file: string) => new URL(`src/pages/og/_fonts/${file}`, root);

// FT Kunst Grotesk is licensed, so it isn't in this repository (README, "Deployment").
async function downloadTitleFont(): Promise<Uint8Array | undefined> {
  const file = process.env.OG_FONT_FILE;
  if (file) return new Uint8Array(await readFile(file));
  const account = process.env.API_DOCS_CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.OG_FONT_TOKEN;
  if (!account || !token) {
    console.warn(`[og] No OG_FONT_TOKEN or API_DOCS_CLOUDFLARE_ACCOUNT_ID; card titles are set in Inter`);
    return undefined;
  }
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${FONT_BUCKET}/objects/${FONT_KEY}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.warn(`[og] Could not download ${FONT_KEY}; card titles are set in Inter`, error);
    return undefined;
  }
}

const kunst = await downloadTitleFont();
const TITLE_FONT = kunst ? "FT Kunst Grotesk" : "Inter";

const fonts: CardFont[] = [
  ...(kunst ? [{ name: "FT Kunst Grotesk", source: kunst, weight: 500 as const }] : []),
  // Kunst covers Latin letters but little punctuation; Inter draws the rest.
  { name: "Inter", source: font("Inter-Medium.ttf"), weight: 500 },
  { name: "IBM Plex Mono", source: font("IBMPlexMono-Medium.woff"), weight: 500 },
];
const renderer = await createCardRenderer({ width: 1200, height: 630, fonts, emoji: "strip" });

type Style = Record<string, string | number>;
const el = (style: Style, children?: CardNode | CardNode[] | string): CardNode => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children },
});

const PIN: Style = { position: "absolute", width: 10, height: 10, background: "#fff", border: "1.25px solid #c9c9c9", borderRadius: 2 };

const dashes = (direction: "horizontal" | "vertical", style: Style) =>
  el({
    position: "absolute",
    ...(direction === "horizontal"
      ? { height: 1.5, backgroundImage: `linear-gradient(90deg, ${DASH} 55%, transparent 45%)`, backgroundSize: "8px 1.5px" }
      : { width: 1.5, backgroundImage: `linear-gradient(180deg, ${DASH} 55%, transparent 45%)`, backgroundSize: "1.5px 8px" }),
    ...style,
  });

const FRAME = [
  ...[40, 1160].map((x) => dashes("vertical", { top: 0, bottom: 0, left: x })),
  ...[40, 590].map((y) => dashes("horizontal", { left: 0, right: 0, top: y })),
  ...[40, 1160].flatMap((x) => [40.75, 590.75].map((y) => el({ ...PIN, left: x - 5, top: y - 5 }))),
];

const lockup = (height: number): CardNode =>
  el({ position: "absolute", top: M, left: M, alignItems: "center", gap: Math.round(height * 0.42) }, [
    {
      type: "svg",
      props: {
        width: Math.round((height * logo.width) / logo.height),
        height,
        viewBox: `0 0 ${logo.width} ${logo.height}`,
        children: logo.paths.map((d, i) => ({ type: "path", props: { d, fill: logo.fills[i] } })),
      },
    },
    el(
      { fontFamily: TITLE_FONT, fontWeight: 500, fontSize: Math.round(height * 1.06), lineHeight: 1, letterSpacing: "-0.02em", color: INK },
      "Forge",
    ),
  ]);

const title = (lineHeight: number): CardTypography => ({ fontFamily: TITLE_FONT, fontWeight: 500, letterSpacing: "-0.02em", lineHeight, color: INK });

async function fitTitle(text: string) {
  for (const tier of [
    { size: 76, lineHeight: 1.1, lines: 2 },
    { size: 60, lineHeight: 1.16, lines: 2 },
  ]) {
    const fitted = await renderer.fit(text, { width: TITLE_WIDTH, sizes: [tier.size], lines: tier.lines, style: title(tier.lineHeight) });
    if (fitted.text === text) return fitted;
  }
  return renderer.fit(text, { width: TITLE_WIDTH, sizes: [54], lines: 3, style: title(1.18) });
}

const dimensionLine = (top: number) =>
  el({ position: "absolute", top, left: M, width: CONTENT_WIDTH, height: 10 }, [
    dashes("horizontal", { left: 0, right: 0, top: 4 }),
    el({ ...PIN, left: -5, top: 0 }),
    el({ ...PIN, right: -5, top: 0 }),
  ]);

const pill = (label: string) =>
  el(
    {
      fontFamily: "IBM Plex Mono",
      fontWeight: 500,
      lineHeight: 1,
      textTransform: "uppercase",
      padding: "15px 26px",
      background: "#fff",
      border: "1.5px solid #d4d4d4",
      borderRadius: 999,
      fontSize: 24,
      letterSpacing: "0.12em",
      color: INK,
    },
    label,
  );

async function card({ section, title: text }: { section?: string; title: string }): Promise<CardNode> {
  const heading = await fitTitle(text);
  return el({ position: "relative", width: 1200, height: 630, background: "#fff" }, [
    ...FRAME,
    lockup(30),
    el({ position: "absolute", top: 140, left: M, right: M, height: 260, flexDirection: "column", justifyContent: "center" }, heading.node),
    dimensionLine(415),
    // Pills sit clear of the strip X covers with the link's title.
    ...(section ? [el({ position: "absolute", bottom: 120, left: M }, pill(section))] : []),
  ]);
}

export const renderPageCard = async (input: { section?: string; title: string }) => renderer.png(await card(input));

// The site card's title is the site's description; only its first sentence fits.
export const renderSiteCard = async ({ title }: { title: string }) =>
  renderer.png(await card({ title: title.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? title }));
