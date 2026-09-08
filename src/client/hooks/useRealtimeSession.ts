import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError } from "../lib/api";
import { buildVoiceStyleGraph, ensureAudioContext } from "../lib/audio";
import { ConversationAttention } from "../lib/conversationAttention";
import { isExplicitCodingInterruptionRequest } from "../lib/intent";
import type { AttentionState, ConnectionStatus, RealtimeEvent, VoiceStyleId } from "../types";
import type { CodingAgentName, PendingPatch, ToolResult } from "../../shared/contracts";
import { useCodexToolExecution } from "./useCodexToolExecution";

type Logger = (message: string) => void;

type Options = {
  voiceStyle: VoiceStyleId;
  codingAgentRef: { current: CodingAgentName | null };
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
  codingAgentRef,
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
  const [attentionState, setAttentionState] = useState<AttentionState>("waiting");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const audioGraphGenerationRef = useRef(0);
  const conversationRevisionRef = useRef(0);
  const attentionRef = useRef<ConversationAttention | null>(null);
  const attentionReadyRef = useRef(false);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutedRef = useRef(false);
  const onRealtimeResult = useCallback((channel: RTCDataChannel, callId: string, result: ToolResult, interrupted: boolean) => {
    if (dcRef.current === channel) attentionRef.current?.finishToolCall(callId, result, interrupted);
  }, []);
  const { abortCodexTasks, clearAbortControllers, executeToolCall } = useCodexToolExecution({
    addLog,
    updateLog,
    onPendingPatch,
    codingAgentRef,
    dataChannelRef: dcRef,
    conversationRevisionRef,
    onRealtimeResult
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
      if (attentionRef.current?.handleEvent(event)) return;
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

      if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
        const transcript = event.transcript.trim();
        addLog("user", transcript);
        return;
      }

      if (event.type === "response.output_audio_transcript.done" && event.transcript) {
        addLog("assistant", event.transcript);
        return;
      }

    },
    [addLog, onRealtimeError]
  );

  // ---------- Connect / disconnect ----------

  const disconnect = useCallback(() => {
    attentionReadyRef.current = false;
    clearTimeout(confirmationTimerRef.current);
    attentionRef.current?.dispose();
    attentionRef.current = null;
    setAttentionState("waiting");
    const channel = dcRef.current;
    const connection = pcRef.current;
    dcRef.current = null;
    pcRef.current = null;
    channel?.close();
    connection?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    cleanupRemoteAudio();
    onMicStreamEnded();
    abortCodexTasks("Coding agent task was interrupted because the realtime session disconnected.");
    clearAbortControllers();
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    remoteStreamRef.current = null;
    setIsDataChannelOpen(false);
    setMuted(false);
    mutedRef.current = false;
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
        if (pcRef.current === pc && pc.connectionState === "failed") {
          disconnect();
          setStatus("error");
          onSystemLog("Realtime audio connection failed. Disconnect and reconnect the session.");
        }
      };

      pc.ontrack = (event) => {
        if (pcRef.current !== pc) return;
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        remoteStreamRef.current = remoteStream;
        if (attentionReadyRef.current) void connectRemoteAudio(remoteStream, voiceStyle);
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micError) {
        onMicError(micError instanceof Error ? micError.message : String(micError));
        throw micError;
      }
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => { track.enabled = false; });
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      onMicStreamReady(stream);

      // Re-apply instructions + tools over the data channel: some Realtime endpoints and relays
      // ignore the `session` part of the SDP exchange, which leaves the model without coding_task.
      const sessionResponse = await fetch("/api/realtime/session");
      if (!sessionResponse.ok) {
        throw new Error(`Failed to load the Realtime session config: ${await formatApiError(sessionResponse)}`);
      }
      const sessionUpdate: unknown = await sessionResponse.json();

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      attentionRef.current?.dispose();
      attentionRef.current = new ConversationAttention({
        send: (event) => dc.send(JSON.stringify(event)),
        onState: setAttentionState,
        onNotice: onSystemLog,
        onReady: () => {
          if (dcRef.current !== dc) return;
          clearTimeout(confirmationTimerRef.current);
          attentionReadyRef.current = true;
          stream.getAudioTracks().forEach((track) => { track.enabled = !mutedRef.current; });
          if (remoteStreamRef.current) void connectRemoteAudio(remoteStreamRef.current, voiceStyle);
          setStatus("connected");
          addLog("system", "GPT-Realtime-2 voice session connected. Waiting for Elva to be addressed; clear follow-ups do not need her name.");
        },
        onUnsafeSession: () => {
          onRealtimeError("Realtime did not confirm manual response control. Elva disconnected to avoid unsolicited replies.");
          disconnect();
          setStatus("error");
        },
        executeToolCall: (name, callId, args) => { void executeToolCall(name, callId, args); },
        cancelCodingTasks: () => {
          if (abortCodexTasks("Coding agent task was interrupted by an accepted user request.")) {
            addLog("system", "Coding agent task interrupted by user request.");
          }
        }
      });
      dc.onopen = () => {
        if (dcRef.current !== dc) return;
        setIsDataChannelOpen(true);
        confirmationTimerRef.current = setTimeout(() => {
          if (dcRef.current === dc && !attentionReadyRef.current) {
            onRealtimeError("Realtime session confirmation timed out. Elva disconnected without enabling audio.");
            disconnect();
            setStatus("error");
          }
        }, 10_000);
        try {
          dc.send(JSON.stringify(sessionUpdate));
        } catch (error) {
          onRealtimeError(`Failed to register Realtime session: ${String(error)}`);
          disconnect();
          setStatus("error");
        }
      };
      dc.onclose = () => {
        if (dcRef.current !== dc) return;
        disconnect();
      };
      dc.onerror = () => {
        if (dcRef.current !== dc) return;
        disconnect();
        setStatus("error");
      };
      dc.onmessage = (message) => {
        if (dcRef.current === dc) void handleRealtimeEvent(JSON.parse(message.data));
      };

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
    abortCodexTasks,
    addLog,
    connectRemoteAudio,
    disconnect,
    executeToolCall,
    handleRealtimeEvent,
    onMicError,
    onMicStreamReady,
    onRealtimeError,
    onSystemLog,
    preparePlaybackAudio,
    voiceStyle,
    warmVoiceEffects
  ]);

  // ---------- Voice style live re-apply ----------

  useEffect(() => {
    localStorage.setItem("voice-style", voiceStyle);
    if (attentionReadyRef.current && remoteStreamRef.current) {
      void applyVoiceStyleEffect(remoteStreamRef.current, voiceStyle);
    }
  }, [applyVoiceStyleEffect, voiceStyle]);

  // ---------- Public actions ----------

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      mutedRef.current = next;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = attentionReadyRef.current && !next;
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
        if (!attentionRef.current?.sendText(trimmed, isExplicitCodingInterruptionRequest(trimmed))) {
          addLog("system", "Wait for Realtime session confirmation before sending a message.");
        }
        return;
      }

      setIsTextSubmitting(true);
      try {
        const response = await fetch("/api/coding-agent/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed })
        });
        const data = (await response.json()) as { text?: string; error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? "Coding agent text turn failed.");
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
    attentionState,
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
