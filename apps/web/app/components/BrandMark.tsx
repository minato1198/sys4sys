export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 32 32"
        className={`text-fg ${compact ? "size-7" : "size-8"}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      >
        <path d="M4 16h24" />
        <path d="M9 7v9M16 4v12M23 7v9" />
        <path d="M9 25v-9M16 28v-12M23 25v-9" />
        <path d="M6 16h2M24 16h2" />
      </svg>
      <span
        className={`font-semibold tracking-tight text-fg ${compact ? "text-base" : "text-lg"}`}
      >
        sys4sys
      </span>
    </span>
  );
}
