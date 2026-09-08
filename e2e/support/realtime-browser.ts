import type { Page } from "@playwright/test";
import type { RealtimeEvent, RealtimeItem } from "../../src/client/types";

type RealtimeBrowserOptions = {
  microphoneError?: string;
  confirmSession?: boolean;
};

export async function emitInvitedRealtimeReply(page: Page, text: string, output: RealtimeItem[]) {
  const input = page.getByPlaceholder("Ask by text — Enter to send, ⌘Enter from anywhere");
  await input.fill(text);
  await input.press("Enter");
  await page.evaluate((items) => {
    const browser = window as unknown as {
      __e2eRealtimeEvents: { type: string; response?: { metadata?: Record<string, string> } }[];
      __e2eRealtimeDataChannel: { onmessage: ((event: MessageEvent) => void) | null };
    };
    const request = browser.__e2eRealtimeEvents.filter((event) => event.response?.metadata?.attention_reply).at(-1);
    if (!request?.response?.metadata) throw new Error("Expected an explicitly invited Realtime reply.");
    const response = { id: "e2e-invited-response", metadata: request.response.metadata };
    for (const event of [
      { type: "response.created", response },
      { type: "response.done", response: { ...response, status: "completed", output: items } }
    ]) browser.__e2eRealtimeDataChannel.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }, output);
}

export async function installRealtimeBrowserFakes(
  page: Page,
  { microphoneError, confirmSession = true }: RealtimeBrowserOptions = {}
) {
  await page.addInitScript(({ microphoneError: errorMessage, confirmSession }) => {
    type ClientEvent = {
      type: string;
      event_id?: string;
      item?: RealtimeItem;
      session?: unknown;
      response?: { conversation?: string; input?: { id?: string }[]; metadata?: Record<string, string> };
    };
    const sentEvents: ClientEvent[] = [];
    const conversationItems = new Set<string>();
    const conversationCalls = new Set<string>();
    Object.defineProperty(window, "__e2eRealtimeEvents", {
      configurable: true,
      value: sentEvents
    });

    const track = {
      enabled: true,
      kind: "audio",
      stop() {}
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    };
    Object.defineProperty(window, "__e2eMicrophoneTrack", { configurable: true, value: track });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (errorMessage) {
            throw new DOMException(errorMessage, "NotAllowedError");
          }
          return stream;
        }
      }
    });

    class FakeAudioNode {
      connect() {
        return this;
      }

      disconnect() {}
    }

    class FakeAnalyserNode extends FakeAudioNode {
      fftSize = 256;
      frequencyBinCount = 128;

      getByteTimeDomainData(values: Uint8Array) {
        values.fill(128);
      }
    }

    class FakeAudioContext {
      state = "running";
      destination = new FakeAudioNode();

      createMediaStreamSource() {
        return new FakeAudioNode();
      }

      createAnalyser() {
        return new FakeAnalyserNode();
      }

      async resume() {
        this.state = "running";
      }

      async close() {
        this.state = "closed";
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext
    });

    class FakeDataChannel {
      readyState = "connecting";
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private listener: ((event: MessageEvent) => void) | null = null;

      get onmessage() {
        return this.receive;
      }

      set onmessage(listener: ((event: MessageEvent) => void) | null) {
        this.listener = listener;
      }

      private receive = (message: MessageEvent) => {
        const event = JSON.parse(message.data) as RealtimeEvent;
        if (event.type === "input_audio_buffer.committed" && event.item_id) conversationItems.add(event.item_id);
        if (event.type === "response.done" && event.response?.metadata?.attention_reply) {
          const request = sentEvents.find((request) => request.response?.metadata?.attention_reply === event.response!.metadata!.attention_reply);
          if (request?.response && request.response.conversation !== "none" && request.response.input === undefined) {
            for (const item of event.response.output ?? []) {
              if (item.id) conversationItems.add(item.id);
              if (item.type === "function_call" && item.call_id) conversationCalls.add(item.call_id);
            }
          }
        }
        this.listener?.(message);
      };

      private emit(event: unknown) {
        queueMicrotask(() => this.receive(new MessageEvent("message", { data: JSON.stringify(event) })));
      }

      private reject(event: ClientEvent, message: string) {
        this.emit({ type: "error", error: { event_id: event.event_id, message } });
      }

      send(value: string) {
        const event = JSON.parse(value) as ClientEvent;
        sentEvents.push(event);
        if (event.type === "conversation.item.create" && event.item) {
          if (event.item.type === "function_call_output" && !conversationCalls.has(event.item.call_id ?? "")) {
            this.reject(event, `Tool call ID '${event.item.call_id}' not found in conversation.`);
            return;
          }
          if (event.item.id) conversationItems.add(event.item.id);
          this.emit({ type: "conversation.item.added", item: event.item });
        }
        if (event.type === "response.create") {
          const missing = event.response?.input?.find((item) => item.id && !conversationItems.has(item.id));
          if (missing) this.reject(event, `Error adding item: the referenced item with id '${missing.id}' does not exist.`);
        }
        if (event.type === "session.update" && confirmSession) {
          this.emit({ type: "session.updated", session: event.session });
        }
      }

      open() {
        this.readyState = "open";
        this.onopen?.(new Event("open"));
      }

      close() {
        this.readyState = "closed";
        this.onclose?.(new Event("close"));
      }
    }

    class FakeRTCPeerConnection {
      connectionState = "new";
      onconnectionstatechange: ((event: Event) => void) | null = null;
      ontrack: ((event: Event) => void) | null = null;
      private dataChannel: FakeDataChannel | null = null;

      addTrack() {}

      createDataChannel() {
        this.dataChannel = new FakeDataChannel();
        Object.defineProperty(window, "__e2eRealtimeDataChannel", {
          configurable: true,
          value: this.dataChannel
        });
        window.setTimeout(() => this.dataChannel?.open(), 0);
        return this.dataChannel;
      }

      async createOffer() {
        return { type: "offer", sdp: "e2e-offer" };
      }

      async setLocalDescription() {}

      async setRemoteDescription() {
        this.connectionState = "connected";
        this.onconnectionstatechange?.(new Event("connectionstatechange"));
      }

      close() {
        this.connectionState = "closed";
        this.dataChannel?.close();
      }
    }

    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      value: FakeRTCPeerConnection
    });
  }, { microphoneError, confirmSession });
}
