// Builds megha's ACP Registry icons: one 16x16 monochrome glyph per backend, and a contact sheet to
// check them by eye. Run from the repo root: node assets/icons/registry/build.mjs
//
// Registry rules (agentclientprotocol/registry CONTRIBUTING.md): 16x16, square, every fill/stroke is
// currentColor or none. Clients recolor them (T3 floods the alpha with currentColor), so only the shape
// counts. Each icon is a single even-odd path: the megha cloud with the backend's mark cut out of it. No
// clipPath or mask, so there are no ids to collide when a client inlines several icons in one page.
//
// Writes: megha-codex.svg, megha-claude.svg, contact-sheet.png (here), and the same SVGs as
// assets/registry/<id>/icon.svg. sharp is resolved from apps/site (read only).

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const n = (v) => String(+v.toFixed(3));
const pt = ([x, y]) => `${n(x)} ${n(y)}`;

// The megha mark redrawn on the 16 grid (assets/icons/megha.svg is 32x32 and too soft at 16): three
// bumps on a flat base at y=12, and the speech-bubble tail running out to the bottom-left.
const LEFT = { cx: 4.5, cy: 8.5, r: 3.5 };
const TOP = { cx: 8.75, cy: 6, r: 4.5 };
const RIGHT = { cx: 12, cy: 8.75, r: 3.25 };
const TAIL_TIP = [1.1, 15.6];
const TAIL_ROOT = [7.9, 12]; // where the tail's inner edge leaves the base

// Upper intersection of two circles (smaller y).
function meet(a, b) {
  const dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy);
  const along = (a.r ** 2 - b.r ** 2 + d ** 2) / (2 * d), h = Math.sqrt(a.r ** 2 - along ** 2);
  const mx = a.cx + (along * dx) / d, my = a.cy + (along * dy) / d;
  const p1 = [mx + (h * dy) / d, my - (h * dx) / d], p2 = [mx - (h * dy) / d, my + (h * dx) / d];
  return p1[1] < p2[1] ? p1 : p2;
}
const angle = (c, [x, y]) => Math.atan2(y - c.cy, x - c.cx);
// Clockwise on screen (SVG sweep 1) from `from` to `to` around circle c.
function arc(c, from, to) {
  let span = angle(c, to) - angle(c, from);
  while (span < 0) span += 2 * Math.PI;
  return `A${n(c.r)} ${n(c.r)} 0 ${span > Math.PI ? 1 : 0} 1 ${pt(to)}`;
}

function cloudOutline() {
  const tailOuter = [LEFT.cx - Math.sqrt(LEFT.r ** 2 - (11.3 - LEFT.cy) ** 2), 11.3]; // on the left bump
  const p1 = meet(LEFT, TOP), p2 = meet(TOP, RIGHT), bottomRight = [RIGHT.cx, RIGHT.cy + RIGHT.r];
  return [
    `M${pt(tailOuter)}`,
    arc(LEFT, tailOuter, p1),
    arc(TOP, p1, p2),
    arc(RIGHT, p2, bottomRight),
    `L${pt(TAIL_ROOT)}`,
    `C6.3 14.3 3.9 15.6 ${pt(TAIL_TIP)}`,
    `C2.6 14.4 2.8 12.6 ${pt(tailOuter)}Z`,
  ].join("");
}

// Pointy-top hexagon whose vertical sides sit `halfWidth` from the center.
function hexagon(cx, cy, halfWidth) {
  const r = (2 * halfWidth) / Math.sqrt(3);
  return "M" + [...Array(6)].map((_, i) => {
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    return pt([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }).join("L") + "Z";
}

// Four-point spark: points at radius `r`, concave sides pulled in to `waist`.
function spark(cx, cy, r, waist) {
  const P = (x, y) => pt([cx + x, cy + y]);
  return `M${P(0, -r)}Q${P(waist, -waist)} ${P(r, 0)}Q${P(waist, waist)} ${P(0, r)}Q${P(-waist, waist)} ${P(-r, 0)}Q${P(-waist, -waist)} ${P(0, -r)}Z`;
}

// The cut-outs sit in the cloud's body, centered on x=8, with at least a pixel of cloud below them.
// Codex: a hex nut. Its vertical edges land on whole pixels at 16 px (5, 7, 9, 11): 2 px cut, 2 px
// solid center, 2 px cut. Claude: a four-point spark. Neither is the OpenAI or Anthropic logo.
const MARKS = {
  "megha-codex": { title: "megha (Codex Cloud)", cut: hexagon(8, 7.5, 3) + hexagon(8, 7.5, 1) },
  "megha-claude": { title: "megha (Claude Code on the web)", cut: spark(8, 7.4, 3.7, 0.7) },
};

const iconSvg = ({ title, cut }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">\n` +
  `  <title>${title}</title>\n` +
  `  <path fill="currentColor" fill-rule="evenodd" d="${cloudOutline()}${cut}"/>\n` +
  `</svg>\n`;

// Contact sheet: each icon at 16, 32 and 64 px on light and dark, the 16 px render zoomed 6x (nearest
// neighbor, to see the actual pixels), and both side by side in a T3-style 32 px tile.
async function contactSheet(icons) {
  const sharp = createRequire(path.join(root, "apps/site/package.json"))("sharp");
  const LIGHT = { bg: "#f4f4f5", tile: "#e4e4e7", ink: "#27272a" }, DARK = { bg: "#18181b", tile: "#27272a", ink: "#e4e4e7" };
  const render = (svg, size, ink) => sharp(Buffer.from(svg.replaceAll("currentColor", ink)), { density: (72 * size) / 16 }).resize(size, size).png().toBuffer();
  const box = (w, h, background) => ({ create: { width: w, height: h, channels: 4, background } });
  const text = (s, w, h, size = 14, color = "#3f3f46") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="0" y="${h - 8}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" fill="${color}">${s}</text></svg>`);
  const cell = 104, labelW = 170, headH = 34, zoom = 6;
  const cols = [["16", 16, LIGHT], ["32", 32, LIGHT], ["64", 64, LIGHT], ["16", 16, DARK], ["32", 32, DARK], ["64", 64, DARK], ["16 px, 6x", 16, LIGHT], ["16 px, 6x", 16, DARK]];
  const W = labelW + cols.length * cell, H = headH + icons.length * cell + 150;
  const parts = [];
  for (const [i, [label]] of cols.entries()) parts.push({ input: text(label.includes("px") ? label : `${label} px`, cell, headH, 13), left: labelW + i * cell + 8, top: 0 });
  for (const [r, [id, svg]] of icons.entries()) {
    const y = headH + r * cell;
    parts.push({ input: text(id, labelW, cell / 2 + 10), left: 12, top: 0 + y });
    for (const [i, [label, size, th]] of cols.entries()) {
      const x = labelW + i * cell;
      parts.push({ input: box(cell - 8, cell - 8, th.bg), left: x, top: y + 4 });
      if (label.endsWith("6x")) {
        const px = await sharp(box(16, 16, th.bg)).composite([{ input: await render(svg, 16, th.ink) }]).png().toBuffer();
        parts.push({ input: await sharp(px).resize(16 * zoom - 8, 16 * zoom - 8, { kernel: "nearest" }).png().toBuffer(), left: x + 0, top: y + 4 });
      } else {
        parts.push({ input: await render(svg, size, th.ink), left: x + (cell - 8 - size) / 2, top: y + 4 + (cell - 8 - size) / 2 });
      }
    }
  }
  // T3-style rows: a 32 px rounded tile with the glyph filling it, then a 16 px inline glyph and a name.
  const rowY = headH + icons.length * cell + 10;
  for (const [k, th] of [LIGHT, DARK].entries()) {
    const x0 = 12 + k * (W / 2);
    parts.push({ input: box(W / 2 - 24, 130, th.bg), left: x0, top: rowY });
    for (const [r, [id, svg]] of icons.entries()) {
      const y = rowY + 14 + r * 56;
      const tile = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="9" fill="${th.tile}"/></svg>`)).png().toBuffer();
      parts.push({ input: tile, left: x0 + 14, top: y });
      parts.push({ input: await render(svg, 32, th.ink), left: x0 + 18, top: y + 4 });
      parts.push({ input: await render(svg, 16, th.ink), left: x0 + 74, top: y + 12 });
      parts.push({ input: text(id === "megha-codex" ? "Codex Cloud (megha)" : "Claude Code on the web (megha)", 300, 30, 14, th.ink), left: x0 + 98, top: y + 3 });
    }
  }
  return sharp(box(W, H, "#ffffff")).composite(parts).png().toBuffer();
}

const icons = Object.entries(MARKS).map(([id, mark]) => [id, iconSvg(mark)]);
for (const [id, svg] of icons) {
  await writeFile(path.join(here, `${id}.svg`), svg);
  await mkdir(path.join(root, "assets/registry", id), { recursive: true });
  await writeFile(path.join(root, "assets/registry", id, "icon.svg"), svg);
}
await writeFile(path.join(here, "contact-sheet.png"), await contactSheet(icons));
console.log(`wrote ${icons.map(([id]) => `${id}.svg`).join(", ")}, contact-sheet.png and assets/registry/*/icon.svg`);
