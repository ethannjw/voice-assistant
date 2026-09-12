(() => {
  const manager = window.botOutputManager;
  manager._createSourceAudioTrack();
  const context = manager.audioContext;
  try { manager.gainNode.disconnect(context.destination); } catch {}
  const events = [];
  let current = null;

  function played() {
    if (!current) return 0;
    return Math.floor(current.segments.reduce((total, segment) => total + Math.max(0, Math.min(segment.duration, context.currentTime - segment.start)), 0) * 1000);
  }

  function finish(kind) {
    if (!current) return;
    const previous = current;
    const playedMs = played();
    current = null;
    for (const segment of previous.segments) {
      try { segment.source.stop(); segment.source.disconnect(); } catch {}
    }
    manager.disableMic();
    events.push({kind, response_id: previous.id, played_ms: playedMs});
  }

  window.elvaMeeting = {
    command(event) {
      const data = event.data;
      if (event.trigger === 'elva.clear') {
        if (current?.id === data.response_id) finish('cleared');
        return;
      }
      if (event.trigger === 'elva.done') {
        if (current?.id === data.response_id) current.done = true;
        return;
      }
      if (event.trigger !== 'realtime_audio.bot_output' || data.sample_rate !== 24000) throw new Error('INVALID_OUTPUT');
      if (context.state !== 'running') throw new Error('AUDIO_CONTEXT_NOT_RUNNING');
      if (current && current.id !== data.response_id) finish('cleared');
      if (!current) {
        current = {id: data.response_id, next: context.currentTime, segments: [], done: false};
        events.push({kind: 'started', response_id: current.id, played_ms: 0});
      }
      if (current.next - context.currentTime > 20 || current.segments.length > 1000) throw new Error('PLAYBACK_OVERFLOW');
      const binary = atob(data.chunk);
      if (binary.length % 2 || binary.length > 96000) throw new Error('INVALID_PCM');
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const samples = new DataView(bytes.buffer);
      const buffer = context.createBuffer(1, binary.length / 2, 24000);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < channel.length; index++) channel[index] = samples.getInt16(index * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(manager.gainNode);
      const start = Math.max(current.next, context.currentTime);
      const duration = channel.length / 24000;
      source.start(start);
      current.segments.push({source, start, duration});
      current.next = start + duration;
      manager.ensureMicOn();
    },
    poll() {
      if (current?.done && context.currentTime >= current.next) finish('stopped');
      return events.splice(0);
    },
    clear() { finish('cleared'); }
  };
})();
