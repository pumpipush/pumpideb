import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';

/** Icon that matches the semantic meaning of each toast variant. */
function ToastIcon({ variant }: { variant?: string | null }) {
  const base = 'h-[18px] w-[18px] shrink-0 mt-[1px]';
  if (variant === 'success')     return <CheckCircle2 className={`${base} text-emerald-400`} />;
  if (variant === 'destructive') return <XCircle      className={`${base} text-red-400`} />;
  if (variant === 'warning')     return <AlertTriangle className={`${base} text-amber-400`} />;
  return                                <Info          className={`${base} text-blue-400`} />;
}

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        return (
          <Toast key={id} variant={variant} {...props}>
            {/* Left icon — aligns with the accent border */}
            <ToastIcon variant={variant} />

            {/* Content */}
            <div className="flex-1 min-w-0">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>

            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
