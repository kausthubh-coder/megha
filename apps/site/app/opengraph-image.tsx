import { ImageResponse } from "next/og";

// The link preview for chat apps and social sites. Built at build time; colors are the light theme's
// hex values from assets/icons/README.md (ink, megha blue) and app/globals.css (ground, muted).

export const alt = "megha: run T3 Code threads on Codex Cloud and Claude Code on the web";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#18202e";
const MUTED = "#5a6477";
const GROUND = "#f9fafc";
const BLUE = "#2f6fd6";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: GROUND,
          color: INK,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 44, fontWeight: 600 }}>
          <svg width="72" height="72" viewBox="0 0 32 32">
            <g transform="translate(-0.6 -0.75)" fill={INK}>
              <circle cx="10.5" cy="17.75" r="5.75" />
              <circle cx="17.25" cy="13" r="7.75" />
              <circle cx="23" cy="18" r="5.5" />
              <rect x="10.5" y="13" width="12.5" height="10.5" />
              <path d="M8.6 22.2 C8.9 24.6 8.3 26.5 6.6 28.2 C9.9 28.1 12.9 26.4 15 23.4 Z" fill={BLUE} />
            </g>
          </svg>
          megha
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ fontSize: 68, lineHeight: 1.08, letterSpacing: -2, maxWidth: 1000, textWrap: "balance" }}>
            Run T3 Code threads on Codex Cloud and Claude Code on the web
          </div>
          <div style={{ fontSize: 32, color: MUTED }}>Open source. Uses your existing codex and claude logins.</div>
        </div>
      </div>
    ),
    size,
  );
}
