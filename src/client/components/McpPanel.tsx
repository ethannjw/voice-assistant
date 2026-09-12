import { useCallback, useEffect, useState } from "react";
import { Plug } from "lucide-react";
import type { McpConfig, McpInteraction, McpInteractionAnswer, McpPermission, McpStatus } from "../../shared/mcp";

async function api<Result>(url: string, method = "GET", body?: unknown): Promise<Result> {
  const response = await fetch(url, {
    method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "MCP request failed.");
  return data as Result;
}

const EMPTY_STATUS: McpStatus = { servers: [], interactions: [], events: [] };

export function McpPanel() {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<McpStatus>(EMPTY_STATUS);
  const [config, setConfig] = useState<McpConfig>({ mcpServers: {} });
  const [draft, setDraft] = useState('{\n  "mcpServers": {}\n}');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState("");

  const refresh = useCallback(async () => {
    setStatus(await api<McpStatus>("/api/mcp/status"));
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<McpStatus>("/api/mcp/status");
        if (!stopped) setStatus(next);
      } catch {}
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); await refresh().catch(() => {}); }
  };

  const load = async () => {
    const saved = await api<McpConfig>("/api/mcp/config");
    setConfig(saved);
    setDraft(JSON.stringify(saved, null, 2));
    setDirty(false);
  };

  const save = async (next: unknown) => {
    await api("/api/mcp/config", "PUT", next);
    await load();
    setNotice("Configuration saved. Enabled servers connect when used or when you press Connect.");
  };

  const updateServer = (name: string, changes: { enabled?: boolean; permission?: McpPermission }) => {
    void run(() => save({ mcpServers: { ...config.mcpServers, [name]: { ...config.mcpServers[name], ...changes } } }));
  };

  const answer = async (id: string, response: McpInteractionAnswer) => {
    await api(`/api/mcp/interactions/${encodeURIComponent(id)}`, "POST", response);
    await refresh();
  };

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mcp.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="mcp-panel" aria-label="MCP integrations">
      <div className="mcp-heading">
        <div><p className="eyebrow">External capabilities</p><h2><Plug size={17} /> MCP servers</h2></div>
        <button type="button" aria-expanded={expanded} aria-controls="mcp-settings" onClick={() => {
          setExpanded(!expanded);
          if (!expanded) void run(load);
        }}>Manage MCP servers</button>
      </div>
      <p className="mcp-hint">{status.servers.length} configured · {status.servers.filter((server) => server.state === "connected").length} connected{status.interactions.length ? ` · ${status.interactions.length} awaiting you` : ""}</p>

      {status.interactions.map((interaction) => <McpRequest key={interaction.id} interaction={interaction} onAnswer={answer} />)}

      {expanded && <div id="mcp-settings" className="mcp-settings">
        <p className="mcp-hint">Connect any compatible stdio, Streamable HTTP, or legacy SSE server. Local server commands execute on your computer. Only save configurations you trust. Full tool access is the default; change it per server or use tool overrides in JSON.</p>
        <div className="mcp-server-list">
          {status.servers.map((server) => <article className="mcp-server" key={server.name}>
            <div className="mcp-heading"><h3>{server.name}</h3><span className={`mcp-state mcp-state-${server.state}`}>{server.state}</span></div>
            <p className="mcp-hint">{server.type} · {server.toolCount} tools · {server.resourceCount} resources · {server.promptCount} prompts</p>
            {server.error && <p className="project-error">{server.error}</p>}
            <div className="mcp-actions">
              <label><input type="checkbox" checked={server.enabled} disabled={busy || dirty} onChange={(event) => updateServer(server.name, { enabled: event.target.checked })} /> Enabled</label>
              <label>Permission <select aria-label={`Permission for ${server.name}`} value={server.permission} disabled={busy || dirty} onChange={(event) => updateServer(server.name, { permission: event.target.value as McpPermission })}>
                <option value="allow">Allow all</option><option value="ask">Ask first</option><option value="deny">Deny all</option>
              </select></label>
              <button disabled={busy || !server.enabled} aria-label={`Connect ${server.name}`} onClick={() => void run(async () => { await api(`/api/mcp/servers/${encodeURIComponent(server.name)}/connect`, "POST"); })}>Connect</button>
              <button disabled={busy || !server.enabled} aria-label={`Reconnect ${server.name}`} onClick={() => void run(async () => { await api(`/api/mcp/servers/${encodeURIComponent(server.name)}/reconnect`, "POST"); })}>Reconnect</button>
              <button disabled={busy || !server.enabled} aria-label={`Inspect ${server.name} capabilities`} onClick={() => void run(async () => {
                const result = await api<{ ok: boolean; output: string }>("/api/tools/mcp_list", "POST", { server: server.name });
                if (!result.ok) throw new Error(result.output);
                setCatalog(JSON.stringify(JSON.parse(result.output), null, 2));
              })}>Capabilities</button>
              <button disabled={busy} aria-label={`Clear ${server.name} authentication`} onClick={() => void run(async () => { await api(`/api/mcp/servers/${encodeURIComponent(server.name)}/logout`, "POST"); })}>Clear auth</button>
              <button disabled={busy || dirty} aria-label={`Remove ${server.name}`} onClick={() => void run(async () => {
                const servers = { ...config.mcpServers }; delete servers[server.name]; await save({ mcpServers: servers });
              })}>Remove</button>
            </div>
            {server.authorizationUrl && <a className="mcp-auth-link" href={server.authorizationUrl} target="_blank" rel="noopener noreferrer">Authorize {server.name} in browser</a>}
          </article>)}
        </div>
        {catalog && <details open><summary>Discovered capabilities (first 50; Elva can paginate)</summary><pre className="mcp-output">{catalog}</pre></details>}
        <details><summary>Configuration examples</summary><pre className="mcp-output">{JSON.stringify({
          mcpServers: {
            local: { command: "npx", args: ["-y", "your-mcp-server"], env: { API_TOKEN: "${MY_SERVICE_TOKEN}" }, permission: "allow" },
            remote: { type: "http", url: "https://your-server.example/mcp", permission: "ask", permissions: { safe_search: "allow" } }
          }
        }, null, 2)}</pre><p className="mcp-hint">Environment variables are read by the server process, not your browser. Optional fields: cwd, timeoutMs, headers, oauth.clientId, oauth.clientSecret, oauth.scope. The permissions map uses exact tool names; the separate operationPermissions map controls resource/prompt operations.</p></details>
        <label className="mcp-editor-label" htmlFor="mcp-json">MCP configuration JSON</label>
        <textarea id="mcp-json" rows={12} spellCheck={false} value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setDirty(true); }} />
        <div className="mcp-actions">
          <button disabled={busy} onClick={() => void run(() => save(JSON.parse(draft)))}>Save and trust configuration</button>
          <button disabled={busy} onClick={() => void run(load)}>Reload saved configuration</button>
          <label className="mcp-import">Import JSON<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void run(async () => {
              if (file.size > 1_000_000) throw new Error("MCP configuration must be smaller than 1 MB.");
              const text = await file.text(); JSON.parse(text); setDraft(text); setDirty(true);
              setNotice("Imported into the editor. Review before saving and trusting.");
            });
            event.target.value = "";
          }} /></label>
          <button disabled={busy || dirty} onClick={exportConfig}>Export saved JSON (includes secrets)</button>
        </div>
        <p className="mcp-hint">Saved locally in the harness data directory. Use environment references for secrets. Exported JSON may contain credentials; do not commit it. Project configuration files are never executed automatically.</p>
        {notice && <p role="status" className="mcp-notice">{notice}</p>}
        {status.events.length > 0 && <details><summary>Recent MCP activity</summary><ul className="mcp-events">{status.events.slice(-20).reverse().map((event) => <li key={event.id}>{new Date(event.createdAt).toLocaleTimeString()} · {event.server}: {event.message}</li>)}</ul></details>}
      </div>}
      {error && <p role="alert" className="project-error">{error}</p>}
    </section>
  );
}

function McpRequest({ interaction, onAnswer }: { interaction: McpInteraction; onAnswer: (id: string, answer: McpInteractionAnswer) => Promise<void> }) {
  const [content, setContent] = useState("{}");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (action: McpInteractionAnswer["action"]) => {
    setBusy(true); setError("");
    try { await onAnswer(interaction.id, { action, ...(action === "accept" && interaction.schema ? { content: JSON.parse(content) } : {}) }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to answer MCP request."); }
    finally { setBusy(false); }
  };
  return <article className="mcp-request" aria-label={`MCP request from ${interaction.server}`}>
    <h3>{interaction.server}: {interaction.kind === "permission" ? "Permission required" : "Your input is needed"}</h3>
    <pre className="mcp-output">{interaction.message}</pre>
    {interaction.url && <p><a href={interaction.url} target="_blank" rel="noopener noreferrer">Open server-provided link</a><span className="mcp-hint"> — verify the destination before entering credentials.</span></p>}
    {interaction.schema && <><details><summary>Requested input schema</summary><pre className="mcp-output">{JSON.stringify(interaction.schema, null, 2)}</pre></details><label>Response JSON<textarea aria-label={`Response to ${interaction.server}`} value={content} onChange={(event) => setContent(event.target.value)} rows={4} /></label></>}
    <div className="mcp-actions"><button disabled={busy} onClick={() => void submit("accept")}>Accept request</button><button disabled={busy} onClick={() => void submit("decline")}>Decline request</button><button disabled={busy} onClick={() => void submit("cancel")}>Cancel request</button></div>
    {error && <p role="alert" className="project-error">{error}</p>}
  </article>;
}
