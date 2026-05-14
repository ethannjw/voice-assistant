import { useCallback, useState } from "react";
import type { Toast, ToastLevel } from "../types";

const TOAST_DURATION_MS = 5500;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((level: ToastLevel, title: string, body: string) => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, level, title, body }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return { toasts, pushToast };
}
