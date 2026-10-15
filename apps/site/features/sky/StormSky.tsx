import { InView } from "./InView";
import { LightningFlash } from "./LightningFlash";

// The sky behind the hero: two drifting cloud layers, sheet lightning, and rain under the bank. All of it
// is decoration (aria-hidden), painted once and moved with transform/opacity. Loops stop when the hero
// scrolls out of view, and with reduced motion nothing moves.

type Clump = { x: number; y: number; puffs: [dx: number, dy: number, r: number][] };

// One 1440px tile per layer, repeated three times so the drift can loop on any screen up to 2880px.
const FAR: Clump[] = [
  { x: 60, y: 150, puffs: [[0, 0, 46], [52, -26, 62], [118, -8, 50], [166, 10, 34]] },
  { x: 430, y: 96, puffs: [[0, 0, 36], [44, -22, 52], [100, -4, 40]] },
  { x: 820, y: 170, puffs: [[0, 0, 52], [64, -34, 70], [138, -10, 56], [192, 8, 38]] },
  { x: 1220, y: 110, puffs: [[0, 0, 40], [48, -24, 56], [104, -2, 42]] },
];
const MID: Clump[] = [
  { x: 180, y: 320, puffs: [[0, 0, 70], [80, -44, 96], [180, -16, 80], [258, 10, 54]] },
  { x: 760, y: 360, puffs: [[0, 0, 60], [76, -40, 84], [166, -10, 68]] },
  { x: 1180, y: 300, puffs: [[0, 0, 66], [84, -46, 92], [180, -12, 72], [250, 12, 46]] },
];

function Tile({ clumps, offset }: { clumps: Clump[]; offset: number }) {
  return (
    <g transform={`translate(${offset} 0)`}>
      {clumps.map((c) => (
        <g key={c.x} transform={`translate(${c.x} ${c.y})`}>
          {c.puffs.map(([dx, dy, r]) => (
            <circle key={`${dx}-${dy}`} cx={dx} cy={dy} r={r} />
          ))}
          {/* Flat base, as cumulus have. */}
          <rect x={c.puffs[0][0]} y={-6} width={c.puffs.at(-1)![0] - c.puffs[0][0]} height={c.puffs[0][2] + 6} />
        </g>
      ))}
    </g>
  );
}

function DriftLayer({
  clumps,
  fill,
  drift,
  parallax,
  className,
}: {
  clumps: Clump[];
  fill: string;
  drift: string;
  parallax: string;
  className: string;
}) {
  return (
    <div className={`parallax absolute inset-x-0 ${className}`} style={{ "--parallax": parallax } as React.CSSProperties}>
      <div className="sky-drift w-[4320px]" style={{ "--drift": drift } as React.CSSProperties}>
        <svg width="4320" height="460" viewBox="0 0 4320 460" fill={fill} className="block">
          {[0, 1440, 2880].map((o) => (
            <Tile key={o} clumps={clumps} offset={o} />
          ))}
        </svg>
      </div>
    </div>
  );
}

// Short streaks in a 160px tile; the layer falls exactly one tile per loop, so the loop has no seam.
const rainTile = (len: number, width: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' stroke='black' stroke-width='${width}' stroke-linecap='round'>` +
      [
        [14, 8],
        [58, 92],
        [96, 30],
        [132, 118],
        [36, 132],
        [112, 70],
      ]
        .map(([x, y]) => `<line x1='${x}' y1='${y}' x2='${x}' y2='${y + len}'/>`)
        .join("") +
      "</svg>",
  )}")`;

function Rain({ len, width, fall, className }: { len: number; width: number; fall: string; className: string }) {
  // The tile is drawn in black and used as a mask over the rain color, so it follows the theme.
  return (
    <div
      className={`rain-fall absolute inset-x-0 -top-40 -bottom-40 ${className}`}
      style={
        {
          "--fall": fall,
          background: "var(--rain)",
          maskImage: rainTile(len, width),
          WebkitMaskImage: rainTile(len, width),
          maskSize: "160px 160px",
          WebkitMaskSize: "160px 160px",
        } as React.CSSProperties
      }
    />
  );
}

export function StormSky() {
  return (
    <InView className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,var(--sky-top),var(--sky-low)_62%,var(--bg))]" />
      <DriftLayer clumps={FAR} fill="var(--cloud-far)" drift="220s" parallax="140px" className="top-6" />
      <LightningFlash />
      <DriftLayer clumps={MID} fill="var(--cloud-mid)" drift="130s" parallax="70px" className="top-10 opacity-90" />
      {/* Warm light under the storm, where the bank's base meets the rain. */}
      <div className="absolute inset-x-0 top-[34rem] h-[26rem] bg-[radial-gradient(60%_45%_at_50%_35%,var(--underlight),transparent_70%)] sm:top-[30rem]" />
      {/* Rain from the bank's base down past the thread window, faded at both ends and slanted by the wind. */}
      <div className="absolute inset-x-[-10%] top-[30rem] bottom-0 skew-x-[-10deg] [mask-image:linear-gradient(transparent,black_18%,black_55%,transparent)] sm:top-[26rem]">
        <Rain len={14} width={1} fall="1.25s" className="opacity-70" />
        <Rain len={26} width={1.4} fall="0.72s" className="translate-x-10" />
      </div>
    </InView>
  );
}
