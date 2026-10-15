// The megha mark, inline so it follows currentColor. Same geometry as assets/icons/build.mjs.
export function MeghaMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g transform="translate(-0.6 -0.75)">
        <circle cx="10.5" cy="17.75" r="5.75" />
        <circle cx="17.25" cy="13" r="7.75" />
        <circle cx="23" cy="18" r="5.5" />
        <rect x="10.5" y="13" width="12.5" height="10.5" />
        <path d="M8.6 22.2 C8.9 24.6 8.3 26.5 6.6 28.2 C9.9 28.1 12.9 26.4 15 23.4 Z" />
      </g>
    </svg>
  );
}
