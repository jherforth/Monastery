import { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Tailwind max-width class for the panel. */
  maxWidth?: string;
  /** Set false to keep the modal open on backdrop clicks (e.g. while submitting). */
  closeOnBackdrop?: boolean;
}

/** The one modal shell: dark backdrop, centered panel, backdrop-click to close. */
export function Modal({ open, onClose, title, children, maxWidth = 'max-w-sm', closeOnBackdrop = true }: ModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={() => { if (closeOnBackdrop) onClose(); }}
    >
      <div
        className={`bg-monastery-dark-surface rounded-lg w-full ${maxWidth} p-5 shadow-xl border border-monastery-dark-border`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">{title}</h3>}
        {children}
      </div>
    </div>
  );
}
