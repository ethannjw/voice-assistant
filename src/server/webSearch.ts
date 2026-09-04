export type WebSearchSource = {
  title: string;
  url: string;
};

export type WebSearchResult = {
  text: string;
  sources: WebSearchSource[];
};

export async function runWebSearch(
  query: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<WebSearchResult> {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    throw new Error("FIRECRAWL_BASE_URL is required for web_search.");
  }

  const searchUrl = `${normalizedBaseUrl}${normalizedBaseUrl.endsWith("/v2") ? "" : "/v2"}/search`;
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  const response = await fetch(searchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      query,
      limit: 5,
      sources: ["web"],
      timeout: 15000
    }),
    signal
  });

  const responseText = await response.text();
  const payload = parseJson(responseText);
  if (!response.ok) {
    const message =
      getResponseError(payload) ||
      responseText.trim().slice(0, 500) ||
      `Web search request failed with status ${response.status}.`;
    throw new Error(message);
  }

  const result = extractWebSearchResult(payload);
  if (!result.text) {
    throw new Error("Firecrawl completed the search without returning web results.");
  }
  return result;
}

function extractWebSearchResult(payload: unknown): WebSearchResult {
  const textParts: string[] = [];
  const sources = new Map<string, WebSearchSource>();

  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.web)) {
    return { text: "", sources: [] };
  }

  for (const item of payload.data.web) {
    if (!isRecord(item) || typeof item.url !== "string") continue;
    const title =
      typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url;
    const description =
      typeof item.description === "string" && item.description.trim()
        ? item.description.trim()
        : "No summary was returned.";
    textParts.push(`${textParts.length + 1}. ${title}\n${description}`);
    sources.set(item.url, { title, url: item.url });
  }

  return { text: textParts.join("\n\n"), sources: [...sources.values()] };
}

function getResponseError(payload: unknown) {
  if (!isRecord(payload)) return null;
  if (typeof payload.error === "string") return payload.error;
  if (!isRecord(payload.error)) return null;
  return typeof payload.error.message === "string" ? payload.error.message : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
