// A layer of cloud between two sections that parts as you scroll through it: the left half drifts left,
// the right half right. Driven by a CSS view timeline, so it runs on the compositor and needs no JS.
// Browsers without scroll timelines, and reduced motion, get the same clouds standing still. It sits
// in the gap between sections and covers no content.

type Puff = [cx: number, cy: number, r: number];

// Drawn in a 720x200 box per half; the right half is the left one mirrored and shifted.
const LEFT: Puff[] = [
  [40, 120, 60],
  [120, 90, 78],
  [220, 110, 64],
  [300, 132, 46],
  [150, 150, 70],
  [380, 150, 40],
];
const RIGHT: Puff[] = [
  [680, 116, 62],
  [590, 86, 82],
  [490, 112, 60],
  [410, 140, 44],
  [560, 152, 66],
  [330, 156, 36],
];

function Half({ puffs, side }: { puffs: Puff[]; side: "left" | "right" }) {
  return (
    <div className={`cloud-part-${side} absolute inset-y-0 w-[min(58rem,70%)] ${side === "left" ? "left-0" : "right-0"}`}>
      <svg viewBox="0 0 720 200" preserveAspectRatio={side === "left" ? "xMinYMid meet" : "xMaxYMid meet"} className="size-full overflow-visible">
        <g fill="var(--cloud-far)" transform="translate(0 -18)">
          {puffs.map(([cx, cy, r]) => (
            <circle key={`f${cx}`} cx={side === "left" ? cx + 30 : cx - 30} cy={cy} r={r * 0.9} />
          ))}
        </g>
        <g fill="var(--cloud-mid)">
          {puffs.map(([cx, cy, r]) => (
            <circle key={cx} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      </svg>
    </div>
  );
}

export function CloudBreak({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`cloud-break pointer-events-none relative h-40 overflow-x-clip sm:h-56 ${className}`}>
      <Half puffs={LEFT} side="left" />
      <Half puffs={RIGHT} side="right" />
    </div>
  );
}
