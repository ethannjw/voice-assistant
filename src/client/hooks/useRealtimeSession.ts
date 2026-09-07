import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError } from "../lib/api";
import { buildVoiceStyleGraph, ensureAudioContext } from "../lib/audio";
import { isExplicitCodexInterruptionRequest } from "../lib/intent";
import type { ConnectionStatus, RealtimeEvent, VoiceStyleId } from "../types";
import type { PendingPatch } from "../../shared/contracts";
import { useCodexToolExecution } from "./useCodexToolExecution";

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
  const audioGraphGenerationRef = useRef(0);
  const conversationRevisionRef = useRef(0);
  const { abortCodexTasks, clearAbortControllers, executeToolCall } = useCodexToolExecution({
    addLog,
    updateLog,
    onPendingPatch,
    dataChannelRef: dcRef,
    conversationRevisionRef
  });

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
    audioGraphGenerationRef.current += 1;
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
      const generation = audioGraphGenerationRef.current;

      if (style === "natural") {
        setNativePlaybackMuted(false);
        return;
      }

      try {
        const context = await ensureAudioContext(audioContextRef.current);
        if (generation !== audioGraphGenerationRef.current || remoteStreamRef.current !== stream) {
          return;
        }

        audioContextRef.current = context;
        const source = context.createMediaStreamSource(stream);
        const cleanup = buildVoiceStyleGraph(context, source, style);
        if (generation !== audioGraphGenerationRef.current || remoteStreamRef.current !== stream) {
          cleanup();
          return;
        }

        audioCleanupRef.current = cleanup;
        setNativePlaybackMuted(true);
      } catch (error) {
        if (generation === audioGraphGenerationRef.current) {
          audioCleanupRef.current?.();
          audioCleanupRef.current = null;
          setNativePlaybackMuted(false);
          onSystemLog(`Voice effects are unavailable. Using clean playback: ${String(error)}`);
        }
      }
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

  // ---------- Realtime event router ----------

  const handleRealtimeEvent = useCallback(
    async (event: RealtimeEvent) => {
      if (event.type === "error") {
        const message = event.error?.message ?? "GPT-Realtime-2 voice session error.";
        addLog("system", message);
        onRealtimeError(message);
        return;
      }

      if (event.type === "session.updated") {
        const toolNames = event.session?.tools?.map((tool) => tool.name).filter(Boolean) ?? [];
        addLog(
          "system",
          toolNames.length
            ? `Realtime tools registered: ${toolNames.join(", ")}.`
            : "Realtime session updated, but no tools were registered."
        );
        return;
      }

      if (event.type === "input_audio_buffer.speech_started") {
        // Server-side semantic VAD owns barge-in via interrupt_response. Keep the remote
        // stream and its audio graph connected so a false-positive VAD event cannot latch
        // local playback into a muted state.
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

      if (event.response?.status && event.response.status !== "completed") return;

      const calls = event.response?.output?.filter((item) => item.type === "function_call") ?? [];
      for (const call of calls) {
        if (call.name && call.call_id) {
          await executeToolCall(call.name, call.call_id, call.arguments ?? "{}");
        }
      }
    },
    [abortCodexTasks, addLog, executeToolCall, onRealtimeError]
  );

  // ---------- Connect / disconnect ----------

  const disconnect = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    cleanupRemoteAudio();
    onMicStreamEnded();
    abortCodexTasks("Codex App Server task was interrupted because the realtime session disconnected.");
    clearAbortControllers();
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    remoteStreamRef.current = null;
    setIsDataChannelOpen(false);
    setMuted(false);
    setStatus("disconnected");
  }, [abortCodexTasks, cleanupRemoteAudio, clearAbortControllers, onMicStreamEnded]);

  const connect = useCallback(async () => {
    setStatus("connecting");

    try {
      preparePlaybackAudio();
      await warmVoiceEffects(voiceStyle);
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          setIsDataChannelOpen(false);
          setStatus("error");
          onSystemLog("Realtime audio connection failed. Disconnect and reconnect the session.");
        }
      };

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

      // Re-apply instructions + tools over the data channel: some Realtime endpoints and relays
      // ignore the `session` part of the SDP exchange, which leaves the model without codex_task.
      let sessionUpdate: unknown = null;
      try {
        const sessionResponse = await fetch("/api/realtime/session");
        if (!sessionResponse.ok) {
          throw new Error(await formatApiError(sessionResponse));
        }
        sessionUpdate = await sessionResponse.json();
      } catch (error) {
        onSystemLog(`Failed to load the realtime session config: ${String(error)}`);
      }

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => {
        setIsDataChannelOpen(true);
        setStatus("connected");
        if (sessionUpdate) {
          try {
            dc.send(JSON.stringify(sessionUpdate));
          } catch (error) {
            onSystemLog(`Failed to register realtime tools: ${String(error)}`);
          }
        }
        try {
          dc.send(
            JSON.stringify({
              type: "response.create",
              response: {
                instructions:
                  "Greet the user once as Elva. Say that you are connected and ready. Keep it to one short sentence."
              }
            })
          );
        } catch (error) {
          onSystemLog(`Failed to request the connection greeting: ${String(error)}`);
        }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      disconnect();
      setStatus("error");
      addLog("system", message);
    }
  }, [
    addLog,
    connectRemoteAudio,
    disconnect,
    handleRealtimeEvent,
    onMicError,
    onMicStreamReady,
    onSystemLog,
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
