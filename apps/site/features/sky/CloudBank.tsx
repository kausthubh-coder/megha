// The signature: the megha mark drawn at the size of a section. A union of circles over a flat-based
// body, with the mark's speech-bubble tail hanging from the base. The body is the content's own box, so
// the cloud grows with whatever text sits in it; the circles bulge out of its top and sides.
//
// No viewBox: circle centers are in % of the box and px from its top, radii in px, so the shape keeps
// its proportions at any width. Two crowns, one for phones and one from 640px up.

type Puff = [cx: string, cy: string | number, r: number];

const CROWN_WIDE: Puff[] = [
  ["7%", 84, 84],
  ["19%", 40, 102],
  ["34%", 16, 122],
  ["51%", 2, 136],
  ["67%", 18, 120],
  ["81%", 42, 100],
  ["93%", 86, 80],
];
const SIDES_WIDE: Puff[] = [
  ["1.5%", "50%", 90],
  ["98.5%", "46%", 84],
];
const CROWN_NARROW: Puff[] = [
  ["4%", 46, 62],
  ["24%", 6, 84],
  ["50%", -12, 96],
  ["76%", 4, 82],
  ["96%", 44, 60],
];

function Puffs({ puffs }: { puffs: Puff[] }) {
  return puffs.map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />);
}

function Shape({ fill, transform }: { fill: string; transform?: string }) {
  return (
    <g fill={fill} transform={transform}>
      <rect width="100%" height="100%" rx="64" />
      <g className="hidden sm:inline">
        <Puffs puffs={CROWN_WIDE} />
        <Puffs puffs={SIDES_WIDE} />
      </g>
      <g className="sm:hidden">
        <Puffs puffs={CROWN_NARROW} />
      </g>
    </g>
  );
}

/** The mark's tail (assets/icons/build.mjs), cropped to its own box. */
export function CloudTail({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="6.4 21.6 9 7" className={className} style={style} aria-hidden>
      <path d="M8.6 21.6 L8.6 22.2 C8.9 24.6 8.3 26.5 6.6 28.2 C9.9 28.1 12.9 26.4 15 23.4 L15.2 21.6 Z" fill="var(--bank-low)" />
    </svg>
  );
}

export function CloudBank({
  id,
  children,
  className = "",
  tailClassName = "",
  animateIn = false,
}: {
  /** Unique per page: the gradient and shape ids are derived from it. */
  id: string;
  children: React.ReactNode;
  className?: string;
  tailClassName?: string;
  /** Rise into place on load (the hero). */
  animateIn?: boolean;
}) {
  return (
    <div className={`relative isolate ${className}`}>
      <div aria-hidden className={`pointer-events-none absolute inset-0 -z-10 ${animateIn ? "bank-in" : ""}`}>
        <svg className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id={`${id}-fill`} gradientUnits="userSpaceOnUse" x1="0" y1="-120" x2="0" y2="100%">
              <stop offset="0" stopColor="var(--bank-top)" />
              <stop offset="1" stopColor="var(--bank-low)" />
            </linearGradient>
          </defs>
          {/* A lit rim: the same shape 3px higher, behind the body, shows only along the top edges. */}
          <Shape transform="translate(0 -3)" fill="var(--bank-rim)" />
          <Shape fill={`url(#${id}-fill)`} />
        </svg>
        <CloudTail className={`absolute top-[calc(100%-2px)] h-auto ${animateIn ? "tail-in" : ""} ${tailClassName}`} />
      </div>
      {children}
    </div>
  );
}
