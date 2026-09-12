export type WireEvent = Record<string, any>;

function pcmLength(chunk: unknown) {
  if (typeof chunk !== "string" || chunk.length > 128000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)) throw new Error("Invalid PCM audio.");
  const length = Buffer.from(chunk, "base64").length;
  if (!length || length % 2) throw new Error("Invalid PCM audio.");
  return length;
}

export class MeetingAudioRelay {
  ready = false;
  muted = false;
  readonly stats = {inputBytes: 0, outputBytes: 0, playbackStarts: 0, playbackStops: 0};
  private requests = new Set<string>();
  private accepted = new Set<string>();
  private cancelled = new Set<string>();
  private items = new Map<string, {id: string; index: number; bytes: number}[]>();
  private active?: string;

  constructor(private upstream: (event: WireEvent) => void, private bot: (event: WireEvent) => void, private browser: (event: WireEvent) => void) {}

  control(event: WireEvent) {
    if (event.type === "response.create" && typeof event.response?.metadata?.attention_reply === "string") {
      this.requests.add(event.response.metadata.attention_reply);
      if (this.requests.size > 64) throw new Error("Too many pending responses.");
    }
    if (event.type === "response.cancel") {
      const response = event.response_id ?? this.active;
      if (response) this.cancelled.add(response);
    }
    if (event.type === "output_audio_buffer.clear") {
      if (this.active) {
        this.cancelled.add(this.active);
        this.bot({trigger: "elva.clear", data: {response_id: this.active}});
      }
      return;
    }
    this.upstream(event);
  }

  meeting(event: WireEvent) {
    if (event.trigger === "realtime_audio.mixed") {
      if (event.data?.sample_rate !== 24000) throw new Error("Invalid meeting sample rate.");
      const length = pcmLength(event.data.chunk);
      if (!this.ready || this.muted) return;
      this.stats.inputBytes += length;
      this.upstream({type: "input_audio_buffer.append", audio: event.data.chunk});
    } else if (event.trigger === "elva.playback") {
      const data = event.data;
      if (!this.accepted.has(data?.response_id)) return;
      if (data.kind === "cleared") {
        if (!Number.isFinite(data.played_ms) || data.played_ms < 0) throw new Error("Invalid playback position.");
        let offset = 0;
        for (const item of this.items.get(data.response_id) ?? []) {
          if (data.played_ms < offset + item.bytes / 48) this.upstream({type: "conversation.item.truncate", item_id: item.id, content_index: item.index, audio_end_ms: Math.max(0, Math.floor(data.played_ms - offset))});
          offset += item.bytes / 48;
        }
      } else if (data.kind === "started") this.stats.playbackStarts++;
      else if (data.kind === "stopped") this.stats.playbackStops++;
      else throw new Error("Unknown playback acknowledgement.");
      this.browser({type: `output_audio_buffer.${data.kind}`, response_id: data.response_id});
    } else if (event.trigger === "elva.error") throw new Error("Meeting audio failed.");
  }

  provider(event: WireEvent) {
    if (event.type === "session.updated") {
      const detection = event.session?.audio?.input?.turn_detection;
      if (detection?.create_response !== false || detection?.interrupt_response !== false) throw new Error("Realtime did not confirm manual response control.");
      this.ready = true;
    }
    if (event.type === "response.created" && this.requests.delete(event.response?.metadata?.attention_reply)) {
      this.accepted.add(event.response.id);
      if (this.accepted.size > 64) {
        const oldest = this.accepted.values().next().value!;
        this.accepted.delete(oldest);
        this.items.delete(oldest);
        this.cancelled.delete(oldest);
      }
    }
    if (event.type === "response.output_audio.delta") {
      if (!this.accepted.has(event.response_id) || this.cancelled.has(event.response_id)) return;
      const length = pcmLength(event.delta);
      const items = this.items.get(event.response_id) ?? [];
      const previous = items.at(-1);
      if (previous && previous.id === event.item_id && previous.index === event.content_index) previous.bytes += length;
      else {
        if (items.length >= 32 || items.some(item => item.id === event.item_id && item.index === event.content_index)) throw new Error("Unsupported audio item ordering.");
        items.push({id: event.item_id, index: event.content_index, bytes: length});
      }
      this.items.set(event.response_id, items);
      this.active = event.response_id;
      this.stats.outputBytes += length;
      this.bot({trigger: "realtime_audio.bot_output", data: {response_id: event.response_id, chunk: event.delta, sample_rate: 24000}});
      return;
    }
    if (event.type === "response.done" && this.accepted.has(event.response?.id) && !this.cancelled.has(event.response?.id)) this.bot({trigger: "elva.done", data: {response_id: event.response.id}});
    this.browser(event);
  }
}
