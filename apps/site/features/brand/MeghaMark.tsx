// The megha mark, inline so it follows currentColor. Same geometry as assets/icons/build.mjs.
// `form`: on load the three puffs appear one after another, then the body and the tail (globals.css).
// `tailClassName` colors the tail separately, as in assets/icons/megha-accent.svg.
export function MeghaMark({
  className,
  title,
  form = false,
  tailClassName,
}: {
  className?: string;
  title?: string;
  form?: boolean;
  tailClassName?: string;
}) {
  const i = (n: number) => (form ? ({ "--i": n } as React.CSSProperties) : undefined);
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g transform="translate(-0.6 -0.75)" className={form ? "mark-form" : undefined}>
        <circle cx="10.5" cy="17.75" r="5.75" style={i(0)} />
        <circle cx="17.25" cy="13" r="7.75" style={i(1)} />
        <circle cx="23" cy="18" r="5.5" style={i(2)} />
        <rect x="10.5" y="13" width="12.5" height="10.5" style={i(3)} />
        <path d="M8.6 22.2 C8.9 24.6 8.3 26.5 6.6 28.2 C9.9 28.1 12.9 26.4 15 23.4 Z" style={i(4)} className={tailClassName} />
      </g>
    </svg>
  );
}
