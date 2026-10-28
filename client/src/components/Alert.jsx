import { AlertCircle, Info, CheckCircle2, TriangleAlert } from 'lucide-react';

const ICONS = {
  error: AlertCircle,
  warn: TriangleAlert,
  ok: CheckCircle2,
  info: Info,
};

/**
 * Inline message block. Errors use role="alert" so screen readers announce
 * them immediately; everything else is a polite status.
 */
export function Alert({ tone = 'info', title, children, actions, icon: Icon }) {
  const ResolvedIcon = Icon ?? ICONS[tone] ?? Info;
  const assertive = tone === 'error';
  return (
    <div
      className={`alert alert-${tone}`}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      <ResolvedIcon size={18} aria-hidden="true" />
      <div className="grow">
        {title ? <div className="alert-title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
        {actions ? <div className="alert-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
