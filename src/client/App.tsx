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
  SlidersHorizontal,
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

type VoiceStyleId = "natural" | "console_ai" | "starship" | "synthetic" | "low_orbit";

type VoiceStyle = {
  id: VoiceStyleId;
  name: string;
  detail: string;
};

type ProjectCandidate = {
  name: string;
  path: string;
};

const statusLabels: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error"
};

const VOICE_STYLES: VoiceStyle[] = [
  { id: "natural", name: "Natural", detail: "Clean Codex voice" },
  { id: "console_ai", name: "Console AI", detail: "Tight radio band" },
  { id: "starship", name: "Starship", detail: "Wide command deck" },
  { id: "synthetic", name: "Synthetic", detail: "Crisp machine tone" },
  { id: "low_orbit", name: "Low Orbit", detail: "Deep filtered comms" }
];

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<keyof typeof statusLabels>("idle");
  const [muted, setMuted] = useState(false);
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyleId>(() => {
    const saved = localStorage.getItem("voice-style");
    return isVoiceStyleId(saved) ? saved : "natural";
  });
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isDataChannelOpen, setIsDataChannelOpen] = useState(false);
  const [isTextSubmitting, setIsTextSubmitting] = useState(false);
  const [isDiscoveringProjects, setIsDiscoveringProjects] = useState(false);
  const [projectCandidates, setProjectCandidates] = useState<ProjectCandidate[]>([]);
  const [projectError, setProjectError] = useState("");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refreshConfig();
    void fetchPendingPatch();
  }, []);

  useEffect(() => {
    const node = conversationRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [logs]);

  useEffect(() => {
    localStorage.setItem("voice-style", voiceStyle);

    if (remoteStreamRef.current) {
      void applyVoiceStyleEffect(remoteStreamRef.current, voiceStyle);
    }
  }, [voiceStyle]);

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
      preparePlaybackAudio();
      await warmVoiceEffects(voiceStyle);
      const pc = new RTCPeerConnection();

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        void connectRemoteAudio(remoteStream, voiceStyle);
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel("oai-events");
      dc.onopen = () => {
        setIsDataChannelOpen(true);
        setStatus("connected");
        addLog("system", "Codex App Server realtime session connected. Try: 'inspect this repo'.");
      };
      dc.onclose = () => {
        setIsDataChannelOpen(false);
        setStatus("disconnected");
      };
      dc.onerror = () => {
        setIsDataChannelOpen(false);
        setStatus("error");
      };
      dc.onmessage = (message) => handleRealtimeEvent(JSON.parse(message.data));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("/api/codex/realtime/call", {
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
    void fetch("/api/codex/realtime/stop", { method: "POST" });
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    cleanupRemoteAudio();
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    remoteStreamRef.current = null;
    setIsDataChannelOpen(false);
    setStatus("disconnected");
  }

  async function connectRemoteAudio(stream: MediaStream, style: VoiceStyleId) {
    remoteStreamRef.current = stream;

    const audio = preparePlaybackAudio();
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }

    try {
      await audio.play();
    } catch (error) {
      addLog("system", `Audio playback needs a browser gesture: ${String(error)}`);
    }

    await applyVoiceStyleEffect(stream, style);
  }

  function preparePlaybackAudio() {
    const audio = playbackAudioRef.current ?? new Audio();
    audio.autoplay = true;
    audio.muted = false;
    audio.volume = 1;
    audio.setAttribute("playsinline", "true");
    playbackAudioRef.current = audio;
    return audio;
  }

  async function applyVoiceStyleEffect(stream: MediaStream, style: VoiceStyleId) {
    cleanupAudioGraph();

    if (style === "natural") {
      setNativePlaybackMuted(false);
      return;
    }

    let context: AudioContext;
    try {
      context = await ensureAudioContext();
    } catch (error) {
      setNativePlaybackMuted(false);
      addLog("system", `Voice effects are unavailable. Using clean playback: ${String(error)}`);
      return;
    }

    const source = context.createMediaStreamSource(stream);
    audioCleanupRef.current = buildVoiceStyleGraph(context, source, style);
    setNativePlaybackMuted(true);
  }

  async function warmVoiceEffects(style: VoiceStyleId) {
    if (style === "natural") {
      return;
    }

    try {
      await ensureAudioContext();
    } catch (error) {
      addLog("system", `Voice effects are unavailable. Using clean playback: ${String(error)}`);
    }
  }

  function setNativePlaybackMuted(muted: boolean) {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.muted = muted;
    }
  }

  async function ensureAudioContext() {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("Web Audio is not available in this browser.");
    }

    const context = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = context;

    if (context.state === "suspended") {
      await context.resume();
    }

    return context;
  }

  function cleanupAudioGraph() {
    audioCleanupRef.current?.();
    audioCleanupRef.current = null;
  }

  function cleanupPlaybackAudio() {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.muted = false;
      playbackAudioRef.current.pause();
      playbackAudioRef.current.srcObject = null;
      playbackAudioRef.current = null;
    }
  }

  function cleanupRemoteAudio() {
    cleanupAudioGraph();
    cleanupPlaybackAudio();
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  async function selectProject(projectId: string) {
    if (!config) {
      return;
    }

    if (!projectId) {
      await deselectProject();
      return;
    }

    if (projectId === config.activeProject?.id) {
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

  async function deselectProject() {
    if (isConnected) {
      disconnect();
      addLog("system", "Realtime session disconnected because the active project changed.");
    }

    setProjectError("");
    const response = await fetch("/api/projects/deselect", { method: "POST" });
    const data = await response.json();

    if (!response.ok) {
      setProjectError(String(data.error ?? "Failed to clear the active project."));
      return;
    }

    setConfig((current) => ({
      ...(current ?? data),
      activeProject: data.activeProject as ProjectConfig | null,
      projects: data.projects as ProjectConfig[]
    }));
    setPendingPatch(null);
    addLog("system", "No project selected. Voice chat remains available.");
  }

  async function addProject(candidate: ProjectCandidate) {
    if (isConnected) {
      disconnect();
      addLog("system", "Realtime session disconnected because the active project changed.");
    }

    setProjectError("");
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: candidate.name,
        path: candidate.path
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
    setPendingPatch(null);
    addLog("system", `Added project ${data.activeProject.path}`);
  }

  async function discoverProjects() {
    setProjectError("");
    setIsDiscoveringProjects(true);

    try {
      const response = await fetch("/api/projects/discover", { method: "POST" });
      const data = (await response.json()) as { projects?: ProjectCandidate[]; error?: string };
      if (!response.ok) {
        setProjectError(data.error ?? "Failed to find repositories.");
        return;
      }

      setProjectCandidates(data.projects ?? []);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDiscoveringProjects(false);
    }
  }

  function toggleMute() {
    const nextMuted = !muted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }

  async function sendText() {
    const text = input.trim();
    if (!text || isTextSubmitting) {
      return;
    }

    addLog("user", text);
    setInput("");

    if (dcRef.current?.readyState === "open") {
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
      return;
    }

    setIsTextSubmitting(true);
    try {
      const response = await fetch("/api/codex/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = (await response.json()) as { text?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Codex App Server text turn failed.");
      }

      addLog("assistant", data.text || "(no response)");
    } catch (error) {
      addLog("system", error instanceof Error ? error.message : String(error));
    } finally {
      setIsTextSubmitting(false);
    }
  }

  async function handleRealtimeEvent(event: RealtimeEvent) {
    if (event.type === "error") {
      addLog("system", event.error?.message ?? "Codex App Server realtime error.");
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
  const canSendText = input.trim().length > 0 && !isTextSubmitting;
  const hasProject = Boolean(config?.activeProject);

  return (
    <main className="app-shell">
      <section className="workspace-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Codex App Server // Realtime Voice Link</p>
            <h1>Voice Pair Programmer</h1>
          </div>
          <div className={`status-pill ${status}`}>{statusLabels[status]}</div>
        </header>

        <section className="project-panel" aria-label="Repository workspace">
          <div className="project-heading">
            <div>
              <p className="eyebrow">Current repository</p>
              <h2>{config?.activeProject?.name ?? "No project selected"}</h2>
            </div>
            <Folder size={20} />
          </div>

          <div className="workspace-strip">
            <Code2 size={18} />
            <span>
              {config?.activeProject?.path ??
                "Voice chat is available. Select a project before using repository tools."}
            </span>
          </div>

          <div className="project-row">
            <label className="field-label" htmlFor="project-select">
              Switch repository
            </label>
            <select
              id="project-select"
              value={config?.activeProject?.id ?? ""}
              onChange={(event) => {
                void selectProject(event.target.value);
              }}
              disabled={!config}
            >
              <option value="">No project selected</option>
              {config?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} - {project.path}
                </option>
              ))}
            </select>
          </div>

          <div className="project-add-block">
            <div className="project-add-heading">
              <FolderPlus size={16} />
              <span>Add local repository</span>
            </div>
            <div className="project-discovery-row">
              <button type="button" onClick={discoverProjects} disabled={!config || isDiscoveringProjects}>
                <FolderPlus size={18} />
                {isDiscoveringProjects ? "Searching" : "Find repositories"}
              </button>
            </div>
            {projectCandidates.length ? (
              <div className="project-candidate-list">
                {projectCandidates.map((candidate) => {
                  const alreadyAdded = config?.projects.some((project) => project.path === candidate.path);
                  return (
                    <article key={candidate.path} className="project-candidate">
                      <div>
                        <strong>{candidate.name}</strong>
                        <span>{candidate.path}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void addProject(candidate);
                        }}
                        disabled={!config}
                      >
                        {alreadyAdded ? "Select" : "Add"}
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : null}
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
            disabled={!hasProject}
          >
            <GitPullRequest size={18} />
            Inspect
          </button>
          <button
            type="button"
            onClick={() => {
              void executeToolCall("run_tests", null, "{}");
            }}
            disabled={!hasProject}
          >
            <Play size={18} />
            Tests
          </button>
        </div>

        <section className="voice-panel" aria-label="Voice style">
          <div className="voice-heading">
            <div>
              <p className="eyebrow">Voice profile</p>
              <h2>{VOICE_STYLES.find((style) => style.id === voiceStyle)?.name}</h2>
            </div>
            <SlidersHorizontal size={20} />
          </div>
          <div className="voice-style-grid">
            {VOICE_STYLES.map((style) => (
              <button
                key={style.id}
                type="button"
                className={`voice-style-option ${style.id === voiceStyle ? "active" : ""}`}
                onClick={() => setVoiceStyle(style.id)}
              >
                <span>{style.name}</span>
                <small>{style.detail}</small>
              </button>
            ))}
          </div>
        </section>

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
          <button type="button" onClick={sendText} disabled={!canSendText}>
            <Send size={18} />
          </button>
        </div>

        <div className="conversation-frame">
          <div className="conversation" ref={conversationRef}>
            {logs.length === 0 ? (
              <div className="empty-state">Awaiting transmission — connect and engage</div>
            ) : (
              logs.map((log) => (
                <article key={log.id} className={`message ${log.role}`}>
                  <span>{log.role}</span>
                  <p>{log.text}</p>
                </article>
              ))
            )}
          </div>
        </div>
      </section>

      <aside className="patch-panel">
        <header>
          <div>
            <p className="eyebrow">Human approval required</p>
            <h2>Pending patch</h2>
          </div>
          {pendingPatch ? <span className="patch-id">{pendingPatch.id.slice(0, 8)}</span> : null}
        </header>

        {pendingPatch ? (
          <>
            <div className="diff-frame">
              <pre className="diff-view">{pendingPatch.diff}</pre>
            </div>
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
          <div className="empty-state">No patches in queue — model proposals will surface here</div>
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

function buildVoiceStyleGraph(
  context: AudioContext,
  source: AudioNode,
  style: VoiceStyleId
) {
  const cleanupTasks: Array<() => void> = [];
  const output = context.createGain();

  output.gain.value = 0.9;
  output.connect(context.destination);
  cleanupTasks.push(() => output.disconnect());

  const connectStyledGraph = (effectNodes: AudioNode[], dry: number, wet: number) => {
    const firstEffect = effectNodes[0];
    const lastEffect = effectNodes[effectNodes.length - 1];
    const dryGain = context.createGain();
    const wetGain = context.createGain();

    dryGain.gain.value = dry;
    wetGain.gain.value = wet;
    source.connect(dryGain).connect(output);
    source.connect(firstEffect);
    for (let index = 0; index < effectNodes.length - 1; index += 1) {
      effectNodes[index].connect(effectNodes[index + 1]);
    }
    lastEffect.connect(wetGain).connect(output);
    cleanupTasks.push(() => {
      source.disconnect();
      dryGain.disconnect();
      wetGain.disconnect();
      effectNodes.forEach((node) => node.disconnect());
    });
  };

  if (style === "natural") {
    return () => cleanupTasks.splice(0).forEach((cleanup) => cleanup());
  }

  if (style === "console_ai") {
    const highpass = createBiquad(context, "highpass", 180, 0.7);
    const mid = createBiquad(context, "peaking", 1400, 1.2, 5.2);
    const lowpass = createBiquad(context, "lowpass", 4400, 0.8);

    connectStyledGraph([highpass, mid, lowpass], 0.18, 1);
    return () => cleanupTasks.splice(0).forEach((cleanup) => cleanup());
  }

  if (style === "starship") {
    const highpass = createBiquad(context, "highpass", 120, 0.8);
    const presence = createBiquad(context, "peaking", 2400, 0.9, 3.6);
    const lowpass = createBiquad(context, "lowpass", 6400, 0.7);
    const delay = context.createDelay(0.28);
    const feedback = context.createGain();
    delay.delayTime.value = 0.055;
    feedback.gain.value = 0.16;
    delay.connect(feedback).connect(delay);
    cleanupTasks.push(() => feedback.disconnect());

    connectStyledGraph([highpass, presence, lowpass, delay], 0.72, 0.34);
    return () => cleanupTasks.splice(0).forEach((cleanup) => cleanup());
  }

  if (style === "synthetic") {
    const highpass = createBiquad(context, "highpass", 210, 0.8);
    const presence = createBiquad(context, "peaking", 1850, 1.1, 4.8);
    const lowpass = createBiquad(context, "lowpass", 4600, 0.8);
    const shaper = context.createWaveShaper();

    shaper.curve = makeDistortionCurve(24);
    shaper.oversample = "2x";

    connectStyledGraph([highpass, presence, lowpass, shaper], 0.58, 0.5);
    return () => cleanupTasks.splice(0).forEach((cleanup) => cleanup());
  }

  const highpass = createBiquad(context, "highpass", 90, 0.7);
  const lowShelf = createBiquad(context, "lowshelf", 190, 0.8, 5);
  const lowpass = createBiquad(context, "lowpass", 3000, 0.85);

  connectStyledGraph([highpass, lowShelf, lowpass], 0.28, 1);
  return () => cleanupTasks.splice(0).forEach((cleanup) => cleanup());
}

function createBiquad(
  context: AudioContext,
  type: BiquadFilterType,
  frequency: number,
  q: number,
  gain = 0
) {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  filter.gain.value = gain;
  return filter;
}

function makeDistortionCurve(amount: number) {
  const samples = 2048;
  const curve = new Float32Array(samples);
  const deg = Math.PI / 180;

  for (let i = 0; i < samples; i += 1) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }

  return curve;
}

function isVoiceStyleId(value: string | null): value is VoiceStyleId {
  return VOICE_STYLES.some((style) => style.id === value);
}
