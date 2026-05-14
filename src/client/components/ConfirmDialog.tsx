import type { ConfirmDialogState } from "../types";

type Props = {
  dialog: ConfirmDialogState | null;
  onCancel: () => void;
};

export function ConfirmDialog({ dialog, onCancel }: Props) {
  if (!dialog) {
    return null;
  }
  return (
    <div
      className="toast-stack"
      style={{ top: "50%", right: "50%", transform: "translate(50%, -50%)", zIndex: 300 }}
    >
      <div className="toast info" style={{ minWidth: 360, gap: 10 }}>
        <span className="toast-title">{dialog.title}</span>
        <span>{dialog.body}</span>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button className="primary" type="button" onClick={dialog.onConfirm}>
            {dialog.confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
