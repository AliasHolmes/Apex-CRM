import type { ReactNode } from 'react';
import {
  LayoutDashboard,
  Radar,
  SendHorizontal,
  SquareKanban,
  Users,
  LucideProvider,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * One stroke weight and one size scale for every icon in the app.
 * Pass an icon through <Icon size="sm" /> or use Tailwind size classes; both pick up the
 * default stroke width from IconProvider.
 */
export const ICON_STROKE_WIDTH = 1.75;

export const ICON_SIZES = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
} as const;

export type IconSize = keyof typeof ICON_SIZES;

export function IconProvider({ children }: { children: ReactNode }) {
  return <LucideProvider strokeWidth={ICON_STROKE_WIDTH}>{children}</LucideProvider>;
}

interface IconProps extends Omit<LucideProps, 'size'> {
  icon: LucideIcon;
  size?: IconSize;
}

export function Icon({ icon: Glyph, size = 'sm', ...props }: IconProps) {
  return <Glyph size={ICON_SIZES[size]} aria-hidden="true" {...props} />;
}

const iconChipVariants = cva('inline-flex shrink-0 items-center justify-center rounded-xl', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground',
      brand: 'bg-primary/10 text-primary',
      success: 'bg-success/10 text-success',
      warning: 'bg-warning/10 text-warning',
      danger: 'bg-danger/10 text-danger',
      info: 'bg-info/10 text-info',
    },
    size: {
      sm: 'h-8 w-8',
      md: 'h-10 w-10',
      lg: 'h-12 w-12',
    },
  },
  defaultVariants: { tone: 'brand', size: 'md' },
});

interface IconChipProps extends VariantProps<typeof iconChipVariants> {
  icon: LucideIcon;
  className?: string;
}

const CHIP_GLYPH_SIZE: Record<NonNullable<IconChipProps['size']>, IconSize> = {
  sm: 'sm',
  md: 'md',
  lg: 'md',
};

/** Tinted rounded tile around an icon. Replaces hand-built icon-in-a-box markup. */
export function IconChip({ icon, tone, size, className }: IconChipProps) {
  return (
    <span className={cn(iconChipVariants({ tone, size }), className)}>
      <Icon icon={icon} size={CHIP_GLYPH_SIZE[size ?? 'md']} />
    </span>
  );
}

export type NavIconId = 'overview' | 'workspace' | 'inventory' | 'pipeline' | 'outreach';

/** Primary navigation icons, keyed by DashboardTab id. */
export const NAV_ICONS: Readonly<Record<NavIconId, LucideIcon>> = {
  overview: LayoutDashboard,
  workspace: Radar,
  inventory: Users,
  pipeline: SquareKanban,
  outreach: SendHorizontal,
};
