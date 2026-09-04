import type { Express } from "express";
import { buildSessionConfig, buildSessionUpdate } from "../realtime";
import type { RouteDeps } from "./index";

export function mountRealtimeRoutes(app: Express, { projectStore, realtimeModel, voice }: RouteDeps) {
  // Session config the client re-applies over the data channel once it opens.
  app.get("/api/realtime/session", (_req, res) => {
    res.json(buildSessionUpdate(realtimeModel, voice, projectStore.getActiveProject()));
  });

  app.post("/api/realtime/call", async (req, res) => {
    if (!process.env.OPENAI_API_KEY) {
      res.status(500).send("OPENAI_API_KEY is required for GPT-Realtime-2 voice sessions.");
      return;
    }

    try {
      const preferUdpForFirefox = /\bFirefox\/\d/i.test(req.get("user-agent") ?? "");
      const fd = new FormData();
      fd.set("sdp", req.body);
      fd.set(
        "session",
        JSON.stringify(buildSessionConfig(realtimeModel, voice, projectStore.getActiveProject()))
      );

      const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
      const realtimeUrl = `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/realtime/calls`;
      const response = await fetch(realtimeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Safety-Identifier": "local-dev-user",
          ...(preferUdpForFirefox ? { "X-Amp-Realtime-ICE-Transport": "udp" } : {})
        },
        body: fd
      });

      const text = await response.text();
      if (!response.ok) {
        res
          .status(response.status)
          .type(response.headers.get("content-type") ?? "application/json")
          .send(text);
        return;
      }

      res.status(response.status).type("application/sdp").send(text);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : String(error));
    }
  });
}
