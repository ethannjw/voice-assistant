import { useCallback, useEffect, useRef, useState } from "react";
import { CODEX_TASK_HEARTBEAT_MS } from "../constants";
import { formatApiError } from "../lib/api";
import { buildVoiceStyleGraph, ensureAudioContext } from "../lib/audio";
import { formatCodexHeader } from "../lib/format";
import { isExplicitCodexInterruptionRequest } from "../lib/intent";
import type { CodexHeaderState, ConnectionStatus, RealtimeEvent, VoiceStyleId } from "../types";
import type { PendingPatch, ToolResult } from "../../shared/contracts";

type Logger = (message: string) => void;

type Options = {
  voiceStyle: VoiceStyleId;
  addLog: (role: "system" | "user" | "assistant" | "tool", text: string) => string;
  updateLog: (id: string, text: string) => void;
  onSystemLog: Logger;
  onRealtimeError: (message: string) => void;
  onMicError: (message: string) => void;
  onMicStreamReady: (stream: MediaStream) => void;
  onMicStreamEnded: () => void;
  onPendingPatch: (patch: PendingPatch) => void;
  onApprovalsClear?: () => void;
};

export function useRealtimeSession({
  voiceStyle,
  addLog,
  updateLog,
  onSystemLog,
  onRealtimeError,
  onMicError,
  onMicStreamReady,
  onMicStreamEnded,
  onPendingPatch
}: Options) {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [isDataChannelOpen, setIsDataChannelOpen] = useState(false);
  const [isTextSubmitting, setIsTextSubmitting] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const assistantResponseActiveRef = useRef(false);
  const reconnectAudioOnNextResponseRef = useRef(false);
  const conversationRevisionRef = useRef(0);
  const toolAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const toolAbortReasonsRef = useRef<Map<AbortController, string>>(new Map());

  // ---------- Audio playback helpers ----------

  const preparePlaybackAudio = useCallback(() => {
    const audio = playbackAudioRef.current ?? new Audio();
    audio.autoplay = true;
    audio.muted = false;
    audio.volume = 1;
    audio.setAttribute("playsinline", "true");
    playbackAudioRef.current = audio;
    return audio;
  }, []);

  const setNativePlaybackMuted = useCallback((flag: boolean) => {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.muted = flag;
    }
  }, []);

  const cleanupAudioGraph = useCallback(() => {
    audioCleanupRef.current?.();
    audioCleanupRef.current = null;
  }, []);

  const cleanupPlaybackAudio = useCallback(() => {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.muted = false;
      playbackAudioRef.current.pause();
      playbackAudioRef.current.srcObject = null;
      playbackAudioRef.current = null;
    }
  }, []);

  const cleanupRemoteAudio = useCallback(() => {
    cleanupAudioGraph();
    cleanupPlaybackAudio();
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }, [cleanupAudioGraph, cleanupPlaybackAudio]);

  const applyVoiceStyleEffect = useCallback(
    async (stream: MediaStream, style: VoiceStyleId) => {
      cleanupAudioGraph();

      if (style === "natural") {
        setNativePlaybackMuted(false);
        return;
      }

      let context: AudioContext;
      try {
        context = await ensureAudioContext(audioContextRef.current);
        audioContextRef.current = context;
      } catch (error) {
        setNativePlaybackMuted(false);
        onSystemLog(`Voice effects are unavailable. Using clean playback: ${String(error)}`);
        return;
      }

      const source = context.createMediaStreamSource(stream);
      audioCleanupRef.current = buildVoiceStyleGraph(context, source, style);
      setNativePlaybackMuted(true);
    },
    [cleanupAudioGraph, onSystemLog, setNativePlaybackMuted]
  );

  const warmVoiceEffects = useCallback(
    async (style: VoiceStyleId) => {
      if (style === "natural") return;
      try {
        const ctx = await ensureAudioContext(audioContextRef.current);
        audioContextRef.current = ctx;
      } catch (error) {
        onSystemLog(`Voice effects are unavailable. Using clean playback: ${String(error)}`);
      }
    },
    [onSystemLog]
  );

  const connectRemoteAudio = useCallback(
    async (stream: MediaStream, style: VoiceStyleId) => {
      remoteStreamRef.current = stream;
      reconnectAudioOnNextResponseRef.current = false;

      const audio = preparePlaybackAudio();
      if (audio.srcObject !== stream) {
        audio.srcObject = stream;
      }

      try {
        await audio.play();
      } catch (error) {
        onSystemLog(`Audio playback needs a browser gesture: ${String(error)}`);
      }

      await applyVoiceStyleEffect(stream, style);
    },
    [applyVoiceStyleEffect, onSystemLog, preparePlaybackAudio]
  );

  // ---------- Codex task abort handling ----------

  const abortCodexTasks = useCallback((reason: string) => {
    if (!toolAbortControllersRef.current.size) return false;
    conversationRevisionRef.current += 1;
    for (const controller of toolAbortControllersRef.current) {
      toolAbortReasonsRef.current.set(controller, reason);
      controller.abort();
    }
    return true;
  }, []);

  const interruptAssistantPlayback = useCallback(() => {
    const channel = dcRef.current;
    if (channel?.readyState === "open" && assistantResponseActiveRef.current) {
      try {
        channel.send(JSON.stringify({ type: "response.cancel" }));
        channel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
      } catch (error) {
        onSystemLog(`Failed to interrupt audio output: ${String(error)}`);
      }
    }
    assistantResponseActiveRef.current = false;
    reconnectAudioOnNextResponseRef.current = true;
    cleanupAudioGraph();
    setNativePlaybackMuted(true);
  }, [cleanupAudioGraph, onSystemLog, setNativePlaybackMuted]);

  const resumeAssistantPlayback = useCallback(() => {
    assistantResponseActiveRef.current = true;
    if (!reconnectAudioOnNextResponseRef.current) return;
    reconnectAudioOnNextResponseRef.current = false;
    if (remoteStreamRef.current) {
      void applyVoiceStyleEffect(remoteStreamRef.current, voiceStyle);
    }
  }, [applyVoiceStyleEffect, voiceStyle]);

  // ---------- Tool execution ----------

  const executeToolCall = useCallback(
    async (name: string, callId: string | null, rawArgs: string) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }

      const isCodexTask = name === "codex_task";
      const taskSummary = isCodexTask && typeof args.task === "string" ? args.task.trim() : "";
      const startedAt = Date.now();

      const headerLogId = isCodexTask
        ? addLog("tool", formatCodexHeader(taskSummary, 0, "running"))
        : addLog("tool", `${name}(${rawArgs})`);

      let heartbeat: number | null = null;
      if (isCodexTask) {
        heartbeat = window.setInterval(() => {
          updateLog(headerLogId, formatCodexHeader(taskSummary, Date.now() - startedAt, "running"));
        }, CODEX_TASK_HEARTBEAT_MS);
      }

      const revisionAtStart = conversationRevisionRef.current;
      const abortController = callId ? new AbortController() : null;
      if (abortController) {
        toolAbortControllersRef.current.add(abortController);
      }

      let result: ToolResult;
      try {
        const response = await fetch(`/api/tools/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: abortController?.signal
        });
        result = (await response.json()) as ToolResult;
      } catch (error) {
        if (abortController?.signal.aborted) {
          result = {
            ok: false,
            output:
              toolAbortReasonsRef.current.get(abortController) ?? "Codex App Server task was interrupted."
          };
        } else {
          result = { ok: false, output: error instanceof Error ? error.message : String(error) };
        }
      } finally {
        if (abortController) {
          toolAbortControllersRef.current.delete(abortController);
          toolAbortReasonsRef.current.delete(abortController);
        }
        if (heartbeat !== null) {
          window.clearInterval(heartbeat);
        }
      }

      const interrupted =
        abortController?.signal.aborted || conversationRevisionRef.current !== revisionAtStart;

      if (isCodexTask) {
        const finalState: CodexHeaderState = interrupted
          ? "interrupted"
          : result.ok
            ? "done"
            : "error";
        updateLog(headerLogId, formatCodexHeader(taskSummary, Date.now() - startedAt, finalState));
      }

      if (result.metadata?.pendingPatch) {
        onPendingPatch(result.metadata.pendingPatch as PendingPatch);
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
        if (!interrupted) {
          dcRef.current?.send(JSON.stringify({ type: "response.create" }));
        }
      }
    },
    [addLog, onPendingPatch, updateLog]
  );

  // ---------- Realtime event router ----------

  const handleRealtimeEvent = useCallback(
    async (event: RealtimeEvent) => {
      if (event.type === "error") {
        const message = event.error?.message ?? "GPT-Realtime-2 voice session error.";
        addLog("system", message);
        onRealtimeError(message);
        return;
      }

      if (event.type === "input_audio_buffer.speech_started") {
        interruptAssistantPlayback();
        return;
      }

      if (event.type === "output_audio_buffer.started" || event.type === "response.output_audio.delta") {
        resumeAssistantPlayback();
      }

      if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
        assistantResponseActiveRef.current = false;
        return;
      }

      if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
        const transcript = event.transcript.trim();
        addLog("user", transcript);
        if (isExplicitCodexInterruptionRequest(transcript)) {
          const interrupted = abortCodexTasks(
            "Codex App Server task was interrupted by an explicit user request."
          );
          if (interrupted) {
            addLog("system", "Codex App Server task interrupted by user request.");
          }
        }
        return;
      }

      if (event.type === "response.output_audio_transcript.done" && event.transcript) {
        addLog("assistant", event.transcript);
        return;
      }

      if (event.type !== "response.done") return;

      assistantResponseActiveRef.current = false;
      if (event.response?.status && event.response.status !== "completed") return;

      const calls = event.response?.output?.filter((item) => item.type === "function_call") ?? [];
      for (const call of calls) {
        if (call.name && call.call_id) {
          await executeToolCall(call.name, call.call_id, call.arguments ?? "{}");
        }
      }
    },
    [abortCodexTasks, addLog, executeToolCall, interruptAssistantPlayback, onRealtimeError, resumeAssistantPlayback]
  );

  // ---------- Connect / disconnect ----------

  const disconnect = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    cleanupRemoteAudio();
    onMicStreamEnded();
    abortCodexTasks("Codex App Server task was interrupted because the realtime session disconnected.");
    toolAbortControllersRef.current.clear();
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    remoteStreamRef.current = null;
    assistantResponseActiveRef.current = false;
    reconnectAudioOnNextResponseRef.current = false;
    setIsDataChannelOpen(false);
    setMuted(false);
    setStatus("disconnected");
  }, [abortCodexTasks, cleanupRemoteAudio, onMicStreamEnded]);

  const connect = useCallback(async () => {
    setStatus("connecting");

    try {
      preparePlaybackAudio();
      await warmVoiceEffects(voiceStyle);
      const pc = new RTCPeerConnection();

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        void connectRemoteAudio(remoteStream, voiceStyle);
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micError) {
        onMicError(micError instanceof Error ? micError.message : String(micError));
        throw micError;
      }
      streamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      onMicStreamReady(stream);

      const dc = pc.createDataChannel("oai-events");
      dc.onopen = () => {
        setIsDataChannelOpen(true);
        setStatus("connected");
        addLog(
          "system",
          "GPT-Realtime-2 voice session connected. Coding tasks will be delegated to Codex App Server."
        );
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

      const sdpResponse = await fetch("/api/realtime/call", {
        method: "POST",
        body: offer.sdp,
        headers: { "Content-Type": "application/sdp" }
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
  }, [
    addLog,
    connectRemoteAudio,
    disconnect,
    handleRealtimeEvent,
    onMicError,
    onMicStreamReady,
    preparePlaybackAudio,
    voiceStyle,
    warmVoiceEffects
  ]);

  // ---------- Voice style live re-apply ----------

  useEffect(() => {
    localStorage.setItem("voice-style", voiceStyle);
    if (remoteStreamRef.current) {
      void applyVoiceStyleEffect(remoteStreamRef.current, voiceStyle);
    }
  }, [applyVoiceStyleEffect, voiceStyle]);

  // ---------- Public actions ----------

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, []);

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isTextSubmitting) return;

      addLog("user", trimmed);

      if (dcRef.current?.readyState === "open") {
        dcRef.current.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: trimmed }]
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
          body: JSON.stringify({ text: trimmed })
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
    },
    [addLog, isTextSubmitting]
  );

  return {
    status,
    isConnected: status === "connected",
    isDataChannelOpen,
    isTextSubmitting,
    muted,
    connect,
    disconnect,
    toggleMute,
    sendText,
    executeToolCall
  };
}
