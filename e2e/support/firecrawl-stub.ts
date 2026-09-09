import { createServer } from "node:http";

const port = Number(process.env.E2E_FIRECRAWL_PORT ?? 39_002);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.method === "POST" && request.url === "/v2/search") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      query?: string;
      scrapeOptions?: { formats?: string[] };
    };
    const query = payload.query?.trim() || "missing query";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        data: {
          web: [
            {
              title: "E2E Firecrawl Result",
              url: "https://example.test/firecrawl-result",
              description: `Stub result for ${query}`,
              ...(payload.scrapeOptions?.formats?.includes("markdown") ? {
                markdown: "# Synthetic forecast\n\nSeptember 9, 2026. Glass Harbor high 31°C, low 24°C.",
                metadata: { statusCode: 200 }
              } : {})
            }
          ]
        }
      })
    );
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`E2E Firecrawl stub listening on http://127.0.0.1:${port}`);
});

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);
