import type { Toast } from "../types";

type Props = {
  toasts: Toast[];
};

export function ToastStack({ toasts }: Props) {
  if (!toasts.length) {
    return null;
  }
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.level}`}>
          <span className="toast-title">{toast.title}</span>
          <span>{toast.body}</span>
        </div>
      ))}
    </div>
  );
}
