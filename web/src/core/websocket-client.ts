import type { ConnectionState, MetricSnapshot } from "../domain/types";

export interface WebSocketClientCallbacks {
  onSnapshot(snapshot: MetricSnapshot): void;
  onState(state: ConnectionState): void;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private stopped = false;
  private paused = false;

  constructor(private readonly callbacks: WebSocketClientCallbacks) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.socket?.close(1000, "client stopped");
    this.socket = null;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.callbacks.onState(paused ? "paused" : "connecting");
    if (paused) {
      this.socket?.close(1000, "paused");
      this.clearReconnect();
    } else if (!this.stopped) {
      this.attempt = 0;
      this.connect();
    }
  }

  private connect(): void {
    if (this.stopped || this.paused || this.socket) return;
    this.callbacks.onState(this.attempt ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.callbacks.onState("connected");
    };
    socket.onmessage = event => {
      try {
        const snapshot = JSON.parse(String(event.data)) as MetricSnapshot;
        if (typeof snapshot.timestamp === "number" && snapshot.metrics) {
          this.callbacks.onSnapshot(snapshot);
        }
      } catch (error) {
        console.error("Invalid dashboard snapshot", error);
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped && !this.paused) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const exponential = Math.min(10_000, 250 * 2 ** this.attempt);
    const jitter = Math.random() * Math.min(500, exponential * 0.25);
    this.attempt++;
    this.callbacks.onState("reconnecting");
    this.reconnectTimer = window.setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect();
      },
      exponential + jitter,
    );
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
