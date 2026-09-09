import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export function createMcpFetch(endpoint: URL, configuredHeaders: Record<string, string>, lifetime: AbortSignal, timeoutMs: number, baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    let protocolBody = false;
    if (typeof init?.body === "string") {
      try { protocolBody = JSON.parse(init.body)?.jsonrpc === "2.0"; } catch {}
    }
    if (target.origin === endpoint.origin && (target.pathname === endpoint.pathname || protocolBody)) {
      for (const [name, value] of Object.entries(configuredHeaders)) {
        if (!headers.has(name)) headers.set(name, value);
      }
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      return await baseFetch(input, {
        ...init, headers, redirect: "error",
        signal: AbortSignal.any([lifetime, deadline.signal, ...(init?.signal ? [init.signal] : [])])
      });
    } finally { clearTimeout(timer); }
  };
}
