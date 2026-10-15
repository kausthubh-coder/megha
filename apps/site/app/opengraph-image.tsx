import { ImageResponse } from "next/og";

// The link preview for chat apps and social sites: the hero's storm sky and cloud bank in small. Built at
// build time; colors are the dark theme's tokens from app/globals.css as hex.

export const alt = "megha: run T3 Code threads on Codex Cloud and Claude Code on the web";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const SKY_TOP = "#060611";
const SKY_LOW = "#1b1026";
const BANK_TOP = "#2d2a42";
const BANK_LOW = "#1d1b30";
const RIM = "#504b69";
const INK = "#f4f0e7";
const MUTED = "#afafc1";
const ACCENT = "#51dfdf";
const UNDERLIGHT = "#bd7138";

// The bank: the mark's circles over a flat-based body, in a 1200x630 frame.
const PUFFS: [number, number, number][] = [
  [190, 250, 96],
  [330, 190, 124],
  [500, 150, 146],
  [690, 146, 150],
  [870, 186, 128],
  [1010, 246, 98],
];

function Bank({ fill, dy = 0, tail = true }: { fill: string; dy?: number; tail?: boolean }) {
  return (
    <g fill={fill} transform={`translate(0 ${dy})`}>
      {PUFFS.map(([cx, cy, r]) => (
        <circle key={cx} cx={cx} cy={cy} r={r} />
      ))}
      <rect x="110" y="220" width="980" height="270" rx="70" />
      {tail ? <path d="M330 480 C336 532 322 572 286 608 C356 606 420 570 466 488 Z" /> : null}
    </g>
  );
}

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: `linear-gradient(${SKY_TOP}, ${SKY_LOW})`,
          color: INK,
        }}
      >
        <svg width="1200" height="630" viewBox="0 0 1200 630" style={{ position: "absolute", top: 0, left: 0 }}>
          <defs>
            <linearGradient id="bank" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="490">
              <stop offset="0" stopColor={BANK_TOP} />
              <stop offset="1" stopColor={BANK_LOW} />
            </linearGradient>
            <radialGradient id="under" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor={UNDERLIGHT} stopOpacity="0.35" />
              <stop offset="1" stopColor={UNDERLIGHT} stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="600" cy="560" rx="520" ry="110" fill="url(#under)" />
          <Bank fill={RIM} dy={-4} tail={false} />
          <Bank fill="url(#bank)" />
        </svg>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: 490,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            paddingTop: 70,
            gap: 22,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 34, fontWeight: 600 }}>
            <svg width="46" height="46" viewBox="0 0 32 32">
              <g transform="translate(-0.6 -0.75)" fill={INK}>
                <circle cx="10.5" cy="17.75" r="5.75" />
                <circle cx="17.25" cy="13" r="7.75" />
                <circle cx="23" cy="18" r="5.5" />
                <rect x="10.5" y="13" width="12.5" height="10.5" />
                <path d="M8.6 22.2 C8.9 24.6 8.3 26.5 6.6 28.2 C9.9 28.1 12.9 26.4 15 23.4 Z" fill={ACCENT} />
              </g>
            </svg>
            megha
          </div>
          <div style={{ fontSize: 58, lineHeight: 1.06, letterSpacing: -1.5, maxWidth: 900, textAlign: "center", textWrap: "balance" }}>
            Run T3 Code threads on Codex Cloud and Claude Code on the web
          </div>
          <div style={{ fontSize: 26, color: MUTED }}>Open source. Uses your existing codex and claude logins.</div>
        </div>
      </div>
    ),
    size,
  );
}
