import type { Page } from "@playwright/test";

type RealtimeBrowserOptions = {
  microphoneError?: string;
};

export async function installRealtimeBrowserFakes(
  page: Page,
  { microphoneError }: RealtimeBrowserOptions = {}
) {
  await page.addInitScript(({ microphoneError: errorMessage }) => {
    const sentEvents: unknown[] = [];
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
      onmessage: ((event: MessageEvent) => void) | null = null;

      send(value: string) {
        sentEvents.push(JSON.parse(value) as unknown);
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
  }, { microphoneError });
}
