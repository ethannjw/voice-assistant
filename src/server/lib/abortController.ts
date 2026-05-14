import type { Request, Response } from "express";

/**
 * Create an AbortController that fires when the HTTP client disconnects.
 * Used to stop long-running Codex turns when the browser navigates away.
 */
export function createRequestAbortController(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () => controller.abort();

  req.on("aborted", abort);
  res.on("close", () => {
    if (!res.writableEnded) abort();
  });

  return controller;
}
