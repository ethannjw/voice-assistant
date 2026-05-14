import { useCallback, useEffect, useRef, useState } from "react";
import { SCROLL_BOTTOM_THRESHOLD_PX } from "../constants";
import type { LogEntry, LogRole } from "../types";

export function useConversationLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((role: LogRole, text: string) => {
    const id = crypto.randomUUID();
    setLogs((current) => [...current, { id, role, text }]);
    return id;
  }, []);

  const updateLog = useCallback((id: string, text: string) => {
    setLogs((current) => current.map((log) => (log.id === id ? { ...log, text } : log)));
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    setUnreadCount(0);
  }, []);

  const jumpToBottom = useCallback(() => {
    const node = conversationRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    setAutoScroll(true);
    setUnreadCount(0);
  }, []);

  // Auto-scroll on new logs when at bottom; otherwise count unread.
  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return;
    if (autoScroll) {
      node.scrollTop = node.scrollHeight;
      setUnreadCount(0);
    } else {
      setUnreadCount((current) => current + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs.length]);

  // Listen for user scrolls to toggle auto-scroll.
  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return;
    const onScroll = () => {
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      const atBottom = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD_PX;
      setAutoScroll(atBottom);
      if (atBottom) {
        setUnreadCount(0);
      }
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  return {
    logs,
    addLog,
    updateLog,
    clearLogs,
    autoScroll,
    unreadCount,
    conversationRef,
    jumpToBottom
  };
}
