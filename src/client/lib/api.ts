export async function formatApiError(response: Response) {
  const raw = await response.text();

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        message?: string;
        type?: string;
        code?: string;
      };
    };
    const error = parsed.error;

    if (error?.code === "insufficient_quota") {
      return [
        "OpenAI API quota is insufficient for this project.",
        "Check your OpenAI billing, credits, and project usage limits, then retry Connect.",
        `Original error: ${error.message ?? "insufficient_quota"}`
      ].join("\n");
    }

    if (error?.message) {
      return `${error.message}${error.code ? ` (${error.code})` : ""}`;
    }
  } catch {
    // Fall through to the raw response body.
  }

  return raw || `Realtime connection failed with HTTP ${response.status}.`;
}
