import type { Express, NextFunction, Request, Response } from "express";
import type { McpManager } from "../mcp/manager";
import { createRequestAbortController } from "../lib/abortController";

export function guardMcpRequest(req: Request, res: Response, next: NextFunction) {
  const remote = req.socket.remoteAddress ?? "";
  const hostname = req.hostname;
  const local = remote === "::1" || remote === "127.0.0.1" || remote === "::ffff:127.0.0.1";
  const localHost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
  const origin = req.get("origin");
  if (!local || !localHost || (origin && origin !== `http://${req.get("host")}` && origin !== `https://${req.get("host")}`)) {
    res.status(403).json({ error: "MCP access requires a trusted local, same-origin client." });
    return;
  }
  res.set("Cache-Control", "no-store");
  next();
}

export function mountMcpRoutes(app: Express, mcp: McpManager) {
  app.use("/api/mcp", guardMcpRequest);
  app.get("/api/mcp/status", (_req, res) => { res.json(mcp.status()); });
  app.get("/api/mcp/config", (_req, res) => { res.json(mcp.store.get()); });
  app.put("/api/mcp/config", async (req, res) => {
    try {
      await mcp.configure(req.body);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid MCP configuration." });
    }
  });
  app.post("/api/mcp/servers/:name/connect", async (req, res) => {
    try {
      await mcp.connect(req.params.name);
      await mcp.catalog(req.params.name, createRequestAbortController(req, res).signal);
      res.json({ ok: true });
    } catch {
      res.status(400).json({ error: "Connection failed or requires authentication. Check the server status.", status: mcp.status() });
    }
  });
  app.post("/api/mcp/servers/:name/reconnect", async (req, res) => {
    try { await mcp.reconnect(req.params.name); res.json({ ok: true }); }
    catch { res.status(400).json({ error: "Reconnect failed. Check server status and authentication." }); }
  });
  app.post("/api/mcp/servers/:name/logout", async (req, res) => {
    try { await mcp.logout(req.params.name); res.json({ ok: true }); }
    catch { res.status(400).json({ error: "Unable to clear authentication for this server." }); }
  });
  app.post("/api/mcp/interactions/:id", (req, res) => {
    try { mcp.answer(req.params.id, req.body); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Unable to resolve MCP request." }); }
  });
  app.get("/api/mcp/oauth/callback", async (req, res) => {
    res.set("Referrer-Policy", "no-referrer");
    if (typeof req.query.state !== "string" || typeof req.query.code !== "string") {
      res.status(400).type("text/plain").send("Authorization was declined or the callback is invalid. Return to Elva and reconnect to try again.");
      return;
    }
    try {
      await mcp.finishOAuth(req.query.state, req.query.code);
      res.type("text/plain").send("MCP authentication complete. You can close this tab and return to Elva.");
    } catch {
      res.status(400).type("text/plain").send("MCP authorization failed or expired. Return to Elva and reconnect to try again.");
    }
  });
}
