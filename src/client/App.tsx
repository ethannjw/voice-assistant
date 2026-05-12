import {
  Check,
  Code2,
  Folder,
  FolderPlus,
  GitPullRequest,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Play,
  Send,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppConfig, PendingPatch, ProjectConfig, ToolResult } from "../shared/contracts";

type LogEntry = {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  text: string;
};

type RealtimeEvent = {
  type: string;
  response?: {
    output?: Array<{
      type: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
  transcript?: string;
  delta?: string;
  item?: {
    role?: string;
    content?: Array<{ transcript?: string; text?: string }>;
  };
  error?: {
    message?: string;
  };
};

const statusLabels: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error"
};

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<keyof typeof statusLabels>("idle");
  const [muted, setMuted] = useState(false);
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [projectError, setProjectError] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    void refreshConfig();
    void fetchPendingPatch();
  }, []);

  async function refreshConfig() {
    try {
      const response = await fetch("/api/config");
      setConfig((await response.json()) as AppConfig);
    } catch (error) {
      addLog("system", `Failed to load config: ${String(error)}`);
    }
  }

  async function connect() {
    setStatus("connecting");

    try {
      const pc = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;

      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel("oai-events");
      dc.onopen = () => {
        setStatus("connected");
        addLog("system", "Realtime session connected. Try: 'inspect this repo'.");
      };
      dc.onclose = () => setStatus("disconnected");
      dc.onerror = () => setStatus("error");
      dc.onmessage = (message) => handleRealtimeEvent(JSON.parse(message.data));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("/api/realtime/call", {
        method: "POST",
        body: offer.sdp,
        headers: {
          "Content-Type": "application/sdp"
        }
      });

      if (!sdpResponse.ok) {
        throw new Error(await formatApiError(sdpResponse));
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text()
      });

      pcRef.current = pc;
      dcRef.current = dc;
    } catch (error) {
      setStatus("error");
      addLog("system", error instanceof Error ? error.message : String(error));
      disconnect();
    }
  }

  function disconnect() {
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    setStatus("disconnected");
  }

  async function selectProject(projectId: string) {
    if (!projectId || !config || projectId === config.activeProject.id) {
      return;
    }

    if (isConnected) {
      disconnect();
      addLog("system", "Realtime session disconnected because the active project changed.");
    }

    setProjectError("");
    const response = await fetch(`/api/projects/${projectId}/select`, { method: "POST" });
    const data = await response.json();

    if (!response.ok) {
      setProjectError(String(data.error ?? "Failed to select project."));
      return;
    }

    setConfig((current) => ({
      ...(current ?? data),
      activeProject: data.activeProject as ProjectConfig,
      projects: data.projects as ProjectConfig[]
    }));
    setPendingPatch(null);
    addLog("system", `Working in ${data.activeProject.path}`);
  }

  async function addProject() {
    const path = newProjectPath.trim();
    if (!path) {
      setProjectError("Project path is required.");
      return;
    }

    if (isConnected) {
      disconnect();
      addLog("system", "Realtime session disconnected because the active project changed.");
    }

    setProjectError("");
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newProjectName.trim(),
        path
      })
    });
    const data = await response.json();

    if (!response.ok) {
      setProjectError(String(data.error ?? "Failed to add project."));
      return;
    }

    setConfig((current) => ({
      ...(current ?? data),
      activeProject: data.activeProject as ProjectConfig,
      projects: data.projects as ProjectConfig[]
    }));
    setNewProjectName("");
    setNewProjectPath("");
    setPendingPatch(null);
    addLog("system", `Added project ${data.activeProject.path}`);
  }

  function toggleMute() {
    const nextMuted = !muted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }

  function sendText() {
    const text = input.trim();
    if (!text || !dcRef.current || dcRef.current.readyState !== "open") {
      return;
    }

    dcRef.current.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }]
        }
      })
    );
    dcRef.current.send(JSON.stringify({ type: "response.create" }));
    addLog("user", text);
    setInput("");
  }

  async function handleRealtimeEvent(event: RealtimeEvent) {
    if (event.type === "error") {
      addLog("system", event.error?.message ?? "Realtime API error.");
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      addLog("user", event.transcript);
      return;
    }

    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      addLog("assistant", event.transcript);
      return;
    }

    if (event.type !== "response.done") {
      return;
    }

    const calls = event.response?.output?.filter((item) => item.type === "function_call") ?? [];
    for (const call of calls) {
      if (call.name && call.call_id) {
        await executeToolCall(call.name, call.call_id, call.arguments ?? "{}");
      }
    }
  }

  async function executeToolCall(name: string, callId: string | null, rawArgs: string) {
    addLog("tool", `${name}(${rawArgs})`);

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = {};
    }

    const response = await fetch(`/api/tools/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args)
    });
    const result = (await response.json()) as ToolResult;

    if (result.metadata?.pendingPatch) {
      setPendingPatch(result.metadata.pendingPatch as PendingPatch);
    }

    addLog("tool", result.output || "(no output)");

    if (callId) {
      dcRef.current?.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(result)
          }
        })
      );
      dcRef.current?.send(JSON.stringify({ type: "response.create" }));
    }
  }

  async function fetchPendingPatch() {
    const response = await fetch("/api/patch/pending");
    const data = (await response.json()) as { patch: PendingPatch | null };
    setPendingPatch(data.patch);
  }

  async function applyPendingPatch() {
    if (!pendingPatch) {
      return;
    }

    setIsApplying(true);
    try {
      const response = await fetch(`/api/patch/${pendingPatch.id}/apply`, { method: "POST" });
      const result = (await response.json()) as ToolResult;
      addLog("tool", result.output || (result.ok ? "Patch applied." : "Patch failed."));
      if (result.ok) {
        setPendingPatch(null);
      }
    } finally {
      setIsApplying(false);
    }
  }

  async function discardPendingPatch() {
    if (!pendingPatch) {
      return;
    }

    await fetch(`/api/patch/${pendingPatch.id}`, { method: "DELETE" });
    setPendingPatch(null);
  }

function addLog(role: LogEntry["role"], text: string) {
    setLogs((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role,
        text
      }
    ]);
  }

  const isConnected = status === "connected";

  return (
    <main className="app-shell">
      <section className="workspace-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Codex App Server + Realtime</p>
            <h1>Voice Pair Programmer</h1>
          </div>
          <div className={`status-pill ${status}`}>{statusLabels[status]}</div>
        </header>

        <section className="project-panel" aria-label="Project selector">
          <div className="project-heading">
            <div>
              <p className="eyebrow">Work in a project</p>
              <h2>{config?.activeProject.name ?? "Loading project"}</h2>
            </div>
            <Folder size={20} />
          </div>

          <div className="workspace-strip">
            <Code2 size={18} />
            <span>{config?.activeProject.path ?? "Loading workspace..."}</span>
          </div>

          <div className="project-row">
            <select
              value={config?.activeProject.id ?? ""}
              onChange={(event) => {
                void selectProject(event.target.value);
              }}
              disabled={!config}
            >
              {config?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="project-add-row">
            <input
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="Project name"
            />
            <input
              value={newProjectPath}
              onChange={(event) => setNewProjectPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void addProject();
                }
              }}
              placeholder="/absolute/path/to/project"
            />
            <button type="button" onClick={addProject} disabled={!config}>
              <FolderPlus size={18} />
              Add
            </button>
          </div>

          {projectError ? <p className="project-error">{projectError}</p> : null}
        </section>

        <div className="controls">
          {!isConnected ? (
            <button className="primary" type="button" onClick={connect}>
              <Phone size={18} />
              Connect
            </button>
          ) : (
            <button className="danger" type="button" onClick={disconnect}>
              <PhoneOff size={18} />
              Disconnect
            </button>
          )}
          <button type="button" onClick={toggleMute} disabled={!isConnected}>
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
            {muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            onClick={() => {
              void executeToolCall("workspace_status", null, "{}");
            }}
          >
            <GitPullRequest size={18} />
            Inspect
          </button>
          <button
            type="button"
            onClick={() => {
              void executeToolCall("run_tests", null, "{}");
            }}
          >
            <Play size={18} />
            Tests
          </button>
        </div>

        <div className="prompt-row">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                sendText();
              }
            }}
            placeholder="Ask by text when you do not want to speak"
          />
          <button type="button" onClick={sendText} disabled={!isConnected}>
            <Send size={18} />
          </button>
        </div>

        <div className="conversation">
          {logs.length === 0 ? (
            <div className="empty-state">Connect and ask about the repository.</div>
          ) : (
            logs.map((log) => (
              <article key={log.id} className={`message ${log.role}`}>
                <span>{log.role}</span>
                <p>{log.text}</p>
              </article>
            ))
          )}
        </div>
      </section>

      <aside className="patch-panel">
        <header>
          <div>
            <p className="eyebrow">Human approval</p>
            <h2>Pending patch</h2>
          </div>
          {pendingPatch ? <span className="patch-id">{pendingPatch.id.slice(0, 8)}</span> : null}
        </header>

        {pendingPatch ? (
          <>
            <pre className="diff-view">{pendingPatch.diff}</pre>
            <div className="patch-actions">
              <button className="primary" type="button" onClick={applyPendingPatch} disabled={isApplying}>
                <Check size={18} />
                Apply
              </button>
              <button type="button" onClick={discardPendingPatch}>
                <Trash2 size={18} />
                Discard
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">Patch proposals from the model will appear here.</div>
        )}
      </aside>
    </main>
  );
}

async function formatApiError(response: Response) {
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
