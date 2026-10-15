// Builds the megha icon set: SVG sources, PNG exports and the site's favicons.
// Run from the repo root: node assets/icons/build.mjs
// sharp comes from apps/site's devDependencies (bun keeps packages per workspace, so resolve it there).
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const sharp = createRequire(path.join(root, "apps/site/package.json"))("sharp");

const SIZES = [16, 32, 64, 128, 256, 512];

// Colors match the site tokens (apps/site/app/globals.css). Hex, because favicons and PNG renderers
// don't all read oklch.
const INK = "#18202e"; // --ink in light mode
const PALE = "#eef2f8"; // --ink in dark mode
const ACCENT = "#2f6fd6"; // the megha blue: reads on white and on near-black
const CLAUDE = "#d97757"; // Claude's brand orange, from T3 Code's ClaudeAI icon

// The mark, on a 32x32 grid. A cloud whose base runs out into a speech-bubble tail: a thread that
// lives in the cloud. Built from plain circles so it stays crisp at 16px.
function cloudShapes(fill) {
  return [
    `<circle cx="10.5" cy="17.75" r="5.75" fill="${fill}"/>`,
    `<circle cx="17.25" cy="13" r="7.75" fill="${fill}"/>`,
    `<circle cx="23" cy="18" r="5.5" fill="${fill}"/>`,
    `<rect x="10.5" y="13" width="12.5" height="10.5" fill="${fill}"/>`,
    // Tail: leaves the base just right of the left bump and points down-left.
    `<path d="M8.6 22.2 C8.9 24.6 8.3 26.5 6.6 28.2 C9.9 28.1 12.9 26.4 15 23.4 Z" fill="${fill}"/>`,
  ].join("");
}
// Center the drawing (it spans x 4.75..28.5, y 5.25..28.2) in the 32 box.
const CENTER = `translate(-0.6 -0.75)`;

function svg(body, { size = 32, title } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${
    title ? `<title>${title}</title>` : ""
  }${body}</svg>\n`;
}

const markSvg = (fill) => svg(`<g transform="${CENTER}">${cloudShapes(fill)}</g>`, { title: "megha" });

// Accent version: the same cloud in ink, with the tail in megha blue.
const markAccentSvg = svg(
  `<g transform="${CENTER}">${cloudShapes(INK).replace(/<path([^>]*)fill="[^"]*"/, `<path$1fill="${ACCENT}"`)}</g>`,
  { title: "megha" },
);

// Adaptive favicon: ink on light tabs, pale on dark tabs.
const faviconSvg = svg(
  `<style>.m{fill:${INK}}@media (prefers-color-scheme:dark){.m{fill:${PALE}}}</style><g class="m" transform="${CENTER}">${cloudShapes(
    "inherit",
  ).replaceAll(' fill="inherit"', "")}</g>`,
  { title: "megha" },
);

// App tile for iOS home screens: pale cloud on the megha blue, full bleed (iOS rounds the corners).
const tileSvg = svg(
  `<rect width="32" height="32" fill="${ACCENT}"/><g transform="translate(16 16) scale(0.72) translate(-16 -16) ${CENTER}">${cloudShapes("#ffffff")}</g>`,
);

// Provider icons. The provider logo fills the 32 box; the megha badge sits bottom-right. A transparent
// gap is cut out of the logo around the badge (so it reads on any background), and the badge carries
// a white ring so it still separates from a dark logo on a dark page.
const BADGE = { cx: 25.25, cy: 25.25, r: 6.25 };
const GAP = 1.5;

function badge() {
  const { cx, cy, r } = BADGE;
  const s = (r * 1.3) / 32; // the cloud is ~24 units wide; fit it inside the circle
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ACCENT}" stroke="#ffffff" stroke-width="1"/>`,
    `<g transform="translate(${cx} ${cy + 0.3}) scale(${s}) translate(-16 -16) ${CENTER}">${cloudShapes("#ffffff")}</g>`,
  ].join("");
}

function providerSvg(id, logo, title) {
  const { cx, cy, r } = BADGE;
  const mask = `<mask id="${id}-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${r + GAP}" fill="#000"/></mask>`;
  return svg(`<defs>${mask}</defs><g mask="url(#${id}-gap)">${logo}</g>${badge()}`, { title });
}

// Official marks, copied from T3 Code (apps/web/src/components/Icons.tsx). See README.md.
const OPENAI_PATH =
  "M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z";
const CLAUDE_PATH =
  "m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z";

// OpenAI's viewBox is 100..511 (411 units); Claude's is 256x257. Both scaled to fill 32.
const openaiLogo = (fill) =>
  `<g transform="scale(${32 / 411}) translate(-100 -100)"><path fill="${fill}" fill-rule="evenodd" clip-rule="evenodd" d="${OPENAI_PATH}"/></g>`;
const claudeLogo = `<g transform="translate(0 0.06) scale(${32 / 257})"><path fill="${CLAUDE}" d="${CLAUDE_PATH}"/></g>`;

const icons = {
  "megha": markSvg(INK),
  "megha-on-dark": markSvg(PALE),
  "megha-accent": markAccentSvg,
  "codex-cloud": providerSvg("codex", openaiLogo("#0d0d0d"), "Codex Cloud via megha"),
  "codex-cloud-on-dark": providerSvg("codexd", openaiLogo("#ffffff"), "Codex Cloud via megha"),
  "claude-cloud": providerSvg("claude", claudeLogo, "Claude Code on the web via megha"),
};

// Minimal ICO writer: an ICO can hold PNG images directly (Vista and later, every current browser).
function ico(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

const render = (svgText, size) => sharp(Buffer.from(svgText), { density: 72 * (size / 32) * 2 }).resize(size, size).png().toBuffer();

await mkdir(path.join(here, "png"), { recursive: true });
for (const [name, text] of Object.entries(icons)) {
  await writeFile(path.join(here, `${name}.svg`), text);
  for (const size of SIZES) await writeFile(path.join(here, "png", `${name}-${size}.png`), await render(text, size));
}

// Site favicons (Next.js app/ file conventions: favicon.ico, icon.svg, apple-icon.png).
const appDir = path.join(root, "apps/site/app");
const icoSizes = [16, 32, 48];
await writeFile(path.join(appDir, "favicon.ico"), ico(await Promise.all(icoSizes.map(async (size) => ({ size, data: await render(icons.megha, size) })))));
await writeFile(path.join(appDir, "icon.svg"), faviconSvg);
await writeFile(path.join(appDir, "apple-icon.png"), await render(tileSvg, 180));
await writeFile(path.join(here, "favicon.svg"), faviconSvg);
await writeFile(path.join(here, "png", "apple-touch-icon-180.png"), await render(tileSvg, 180));

// --sheet: a contact sheet (16..128px, light and dark side by side) for checking the small sizes by eye.
const rows = Object.entries(icons);
if (process.argv.includes("--sheet")) {
  const sheetSizes = [16, 32, 64, 128];
  const half = 20 + sheetSizes.reduce((a, s) => a + s + 20, 0);
  const composites = [];
  let y = 20;
  for (const [, text] of rows) {
    for (const [i] of ["light", "dark"].entries()) {
      let x = 20 + i * half;
      for (const size of sheetSizes) {
        composites.push({ input: await render(text, size), left: x, top: y + (128 - size) / 2 });
        x += size + 20;
      }
    }
    y += 148;
  }
  const bgs = [
    { input: { create: { width: half, height: y, channels: 4, background: "#ffffff" } }, left: 0, top: 0 },
    { input: { create: { width: half, height: y, channels: 4, background: "#141a24" } }, left: half, top: 0 },
  ];
  const sheet = await sharp({ create: { width: half * 2, height: y, channels: 4, background: "#ffffff" } })
    .composite([...bgs, ...composites])
    .png()
    .toBuffer();
  await writeFile(path.join(root, "apps/site/screenshots/icons-sheet.png"), sheet);
}
console.log(`wrote ${rows.length} icons x ${SIZES.length} sizes, favicon.ico, icon.svg, apple-icon.png`);
