/**
 * Inline icons. Kept as components (not an icon package) so the bundle stays
 * small and the strokes stay consistent with the rest of the UI.
 */
type IconProps = { size?: number; className?: string };

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SlidersIcon({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </svg>
  );
}

export function ClockIcon({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.8V12l3 1.8" />
    </svg>
  );
}

export function RefreshIcon({ size = 15, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.8 4.6v4.2h-4.2" />
    </svg>
  );
}

export function ImageIcon({ size = 22, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="8.6" cy="9.6" r="1.5" />
      <path d="M4 16.5l4.6-4.2 4 3.4 3-2.4 4.4 3.6" />
    </svg>
  );
}

export function FolderIcon({ size = 15, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M3.6 7.4a2 2 0 0 1 2-2h3.3l2 2.2h7.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 15, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5" />
    </svg>
  );
}

export function CheckIcon({ size = 15, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

/**
 * The app mark, drawn from the same numbers as `apps/desktop/src-tauri/icons`:
 * seven ellipses in a level row, each tilted 46° up to the right, on a white
 * plate. Small enough that the tilt reads as texture rather than as shapes.
 */
const MARK_COLOURS = ["#E8958B", "#E7A575", "#E2C67D", "#9BC48D", "#8BC4BA", "#8FAEDB", "#B49BD3"];

export function BrandMark({ size = 18, className }: IconProps) {
  const step = (1024 * 0.76) / (MARK_COLOURS.length - 1);
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden>
      <rect x="56" y="56" width="912" height="912" rx="205" fill="#ffffff" />
      <clipPath id="brand-clip">
        <rect x="56" y="56" width="912" height="912" rx="205" />
      </clipPath>
      <g clipPath="url(#brand-clip)">
        {MARK_COLOURS.map((color, index) => {
          const cx = 512 + (index - (MARK_COLOURS.length - 1) / 2) * step;
          return (
            <ellipse
              key={color}
              cx={cx}
              cy={512}
              rx={1024 * 0.13}
              ry={1024 * 0.09}
              fill={color}
              opacity={0.82}
              transform={`rotate(-46 ${cx} 512)`}
            />
          );
        })}
      </g>
    </svg>
  );
}

export function TrashIcon({ size = 15, className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} {...base}>
      <path d="M4 7h16M9.5 7V5.2h5V7M6.5 7l.8 12.2h9.4L17.5 7" />
      <path d="M10.2 10.5v6M13.8 10.5v6" />
    </svg>
  );
}
