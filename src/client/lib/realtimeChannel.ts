export type RealtimeChannel = { readyState: string; send: (data: string) => void; close: () => void };

export class MeetingChannel implements RealtimeChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private socket: WebSocket) {
    socket.onopen = () => {
      this.heartbeat = setInterval(() => {if (socket.readyState === WebSocket.OPEN) this.send(JSON.stringify({type: "elva.heartbeat"}));}, 5000);
      this.onopen?.();
    };
    socket.onmessage = event => this.onmessage?.(event);
    socket.onerror = () => this.onerror?.();
    socket.onclose = () => {clearInterval(this.heartbeat); this.onclose?.();};
  }

  get readyState() { return ["connecting", "open", "closing", "closed"][this.socket.readyState]; }
  send(data: string) { this.socket.send(data); }
  close() { clearInterval(this.heartbeat); this.socket.close(); }
}
