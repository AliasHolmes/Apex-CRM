import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** DOM id for the heading, so the surrounding region can use aria-labelledby. */
  id: string;
  title: string;
  description: string;
  actions?: ReactNode;
}

/** Shared title block so every workspace tab opens the same way. */
export function PageHeader({ id, title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl">
        <h2 id={id} className="text-2xl font-extrabold tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
