import brandLogo from '../../assets/brand-logo.png';

interface BrandMarkProps {
  readonly size?: number;
}

/**
 * The Artemis mark: the crescent-moon artwork on the near-black workshop
 * tile. Self-colored, so it reads the same in light and dark themes and from
 * 16px up to full app-icon size.
 */
export function BrandMark({ size = 29 }: BrandMarkProps) {
  return (
    <span
      className="brand-mark"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: '#171b18',
        boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 12%)',
      }}
    >
      <img src={brandLogo} alt="" draggable={false} width={size} height={size} />
    </span>
  );
}
