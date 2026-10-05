import { cn } from '@/lib/utils';

interface ApexLogoProps {
  className?: string;
  /** Render only the glyph, without the rounded tile. */
  bare?: boolean;
}

/**
 * Apex mark: a peak with a prospect node beneath it. Colors come from theme tokens so it
 * follows light and dark mode. Keep the geometry in sync with public/favicon.svg.
 */
export function ApexLogo({ className, bare = false }: ApexLogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="Apex CRM"
      className={cn('h-10 w-10', className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      {!bare && <rect width="32" height="32" rx="8" className="fill-primary" />}
      <path
        d="M7.5 23.5 16 8.5l8.5 15"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={bare ? 'stroke-primary' : 'stroke-primary-foreground'}
      />
      <circle cx="16" cy="20" r="2" className={bare ? 'fill-primary' : 'fill-primary-foreground'} />
    </svg>
  );
}
