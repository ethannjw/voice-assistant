import { expect, test } from "@playwright/test";
import { runWebSearch } from "../src/server/webSearch";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const forecast = {
  url: "https://weather.example.test/forecast",
  title: "Fixture Weather Bureau",
  description: "See tomorrow's high and low temperatures.",
  markdown: "# Glass Harbor forecast\n\nSeptember 9, 2026. High 31°C. Low 24°C.",
  metadata: { statusCode: 200 }
};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});

function respond(payload: unknown, status = 200) {
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status });
}

test("web search requests fresh page content and delivers values absent from snippets", async () => {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const extracted = body.scrapeOptions?.formats?.includes("markdown") && body.scrapeOptions?.maxAge === 0;
    return new Response(JSON.stringify({ success: true, data: { web: [{ ...forecast, markdown: extracted ? forecast.markdown : undefined }] } }));
  };
  const result = await runWebSearch("Glass Harbor forecast high low", "http://firecrawl.example.test");
  expect(result.text).toContain("High 31°C. Low 24°C.");
  expect(result.text).toContain("September 9, 2026");
  expect(result.text).toContain(forecast.url);
  expect(result.sources[0]).toMatchObject({ title: forecast.title, url: forecast.url, contentStatus: "scraped" });
});

test("web search retains successful pages while labeling failed pages as snippet-only", async () => {
  respond({ success: true, data: { web: [
    { ...forecast, url: "https://weather.example.test/blocked", markdown: "Fake high 999°C", metadata: { statusCode: 403 } },
    forecast
  ] } });
  const result = await runWebSearch("forecast", "http://firecrawl.example.test/v2/");
  expect(result.text).toContain("31°C");
  expect(result.text).not.toContain("999°C");
  expect(result.sources).toMatchObject([{ contentStatus: "snippet_only", statusCode: 403 }, { contentStatus: "scraped" }]);
  expect(result.text).toContain("Snippet only");
});

test("web search preserves useful excerpts beyond long navigation without unbounded output", async () => {
  respond({ success: true, data: { web: [{
    ...forecast,
    markdown: `${"Menu\nNavigation link\n\n".repeat(1800)}${forecast.markdown}\n\n${"Footer link\n\n".repeat(1800)}`
  }] } });
  const result = await runWebSearch("Glass Harbor forecast high low", "http://firecrawl.example.test");
  expect(result.text).toContain("High 31°C. Low 24°C.");
  expect(result.text).toContain("September 9, 2026");
  expect(result.text.length).toBeLessThan(15_000);
  expect(result.sources[0]).toMatchObject({ truncated: true });
});

test("web search handles scraped metadata URLs and deduplicates sources", async () => {
  respond({ success: true, data: { web: [
    { markdown: forecast.markdown, metadata: { sourceURL: forecast.url, title: forecast.title, statusCode: 200 } },
    forecast,
    { title: "invalid", markdown: "not a valid result" }
  ] } });
  const result = await runWebSearch("forecast", "http://firecrawl.example.test");
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].title).toBe(forecast.title);
  expect(result.text.match(/High 31°C/g)).toHaveLength(1);
});

test("web search reports missing page content instead of implying the question is answered", async () => {
  respond({ success: true, data: { web: [{ ...forecast, markdown: undefined }] } });
  const result = await runWebSearch("forecast high low", "http://firecrawl.example.test");
  expect(result.text).toContain("Snippet only");
  expect(result.sources[0]).toMatchObject({ contentStatus: "snippet_only" });
});

test("web search limits returned sources and oversized provider fields", async () => {
  respond({ success: true, data: { web: Array.from({ length: 12 }, (_value, index) => ({
    ...forecast, title: "title".repeat(10_000), description: "summary".repeat(10_000), url: `${forecast.url}/${index}`
  })) } });
  const result = await runWebSearch("forecast", "http://firecrawl.example.test");
  expect(result.sources).toHaveLength(5);
  expect(result.text.length).toBeLessThan(75_000);
});

test("web search rejects provider failures even with HTTP 200 and misleading data", async () => {
  respond({ success: false, error: "Provider unavailable", data: { web: [forecast] } });
  await expect(runWebSearch("forecast", "http://firecrawl.example.test")).rejects.toThrow("Provider unavailable");
});

test("web search reports empty results and preserves HTTP errors", async () => {
  respond({ success: true, data: { web: [] } });
  await expect(runWebSearch("forecast", "http://firecrawl.example.test")).rejects.toThrow("without returning web results");
  respond({ error: "Search service unavailable" }, 503);
  await expect(runWebSearch("forecast", "http://firecrawl.example.test")).rejects.toThrow("Search service unavailable");
});

test("web search preserves caller cancellation alongside a bounded request deadline", async () => {
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    forwardedSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  const pending = runWebSearch("forecast", "http://firecrawl.example.test", controller.signal);
  controller.abort(new Error("User disconnected"));
  await expect(pending).rejects.toThrow("User disconnected");
  expect(forwardedSignal?.aborted).toBe(true);
});

test("web search aborts a stalled provider when its own deadline expires", async () => {
  const deadline = new AbortController();
  AbortSignal.timeout = () => deadline.signal;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const pending = runWebSearch("forecast", "http://firecrawl.example.test");
  deadline.abort(new Error("Search deadline exceeded"));
  await expect(pending).rejects.toThrow("Search deadline exceeded");
});
