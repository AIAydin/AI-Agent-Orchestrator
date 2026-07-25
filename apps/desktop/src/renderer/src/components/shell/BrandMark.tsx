interface BrandMarkProps {
  readonly size?: number;
}

/**
 * The Forgeboard mark: a geometric F — warm off-white stroke with an amber
 * forge bar — on the near-black workshop tile. Self-colored, so it reads the
 * same in light and dark themes and from 16px up to full app-icon size.
 */
export function BrandMark({ size = 29 }: BrandMarkProps) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="24" height="24" rx="6.5" fill="#171b18" />
      <rect
        x="0.5"
        y="0.5"
        width="23"
        height="23"
        rx="6"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.12"
      />
      <path d="M8.5 10.95h5.4a1.55 1.55 0 0 1 0 3.1H8.5Z" fill="#dda45e" />
      <path
        d="M8.1 17.4V9.3a2.6 2.6 0 0 1 2.6-2.6h5.2"
        fill="none"
        stroke="#f3f4f2"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
    </svg>
  );
}
