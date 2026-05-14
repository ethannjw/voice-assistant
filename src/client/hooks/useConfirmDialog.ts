import { useCallback, useState } from "react";
import type { ConfirmDialogState } from "../types";

export function useConfirmDialog() {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const closeDialog = useCallback(() => setConfirmDialog(null), []);

  const requestConfirm = useCallback(
    (dialog: Omit<ConfirmDialogState, "onConfirm"> & { onConfirm: () => void | Promise<void> }) => {
      setConfirmDialog({
        ...dialog,
        onConfirm: () => {
          setConfirmDialog(null);
          void dialog.onConfirm();
        }
      });
    },
    []
  );

  return { confirmDialog, requestConfirm, closeDialog };
}
