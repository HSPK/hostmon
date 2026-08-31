import type { ConnectionState, MetricSnapshot } from "../domain/types";

export interface WebSocketClientCallbacks {
  onSnapshot(snapshot: MetricSnapshot): void;
  onState(state: ConnectionState): void;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private inactivityTimer: number | null = null;
  private inactivityTimeoutMilliseconds: number | null = null;
  private latestTimestamp = Number.NEGATIVE_INFINITY;
  private hasReceivedStreamSnapshot = false;
  private attempt = 0;
  private stopped = false;
  private paused = false;

  constructor(private readonly callbacks: WebSocketClientCallbacks) {}

  configureInactivityTimeout(
    timeoutSeconds: number,
    latestTimestamp: number,
  ): void {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new RangeError("WebSocket inactivity timeout must be positive");
    }
    if (!Number.isFinite(latestTimestamp)) {
      throw new RangeError("Latest sample timestamp must be finite");
    }
    this.inactivityTimeoutMilliseconds = timeoutSeconds * 1000;
    this.latestTimestamp = latestTimestamp;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearInactivity();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client stopped");
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.callbacks.onState(paused ? "paused" : "connecting");
    if (paused) {
      this.clearReconnect();
      this.clearInactivity();
      const socket = this.socket;
      this.socket = null;
      socket?.close(1000, "paused");
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
      if (this.socket !== socket) return;
      this.armInactivity(socket);
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const snapshot = JSON.parse(String(event.data)) as MetricSnapshot;
        if (Number.isFinite(snapshot.timestamp) && snapshot.metrics) {
          this.callbacks.onSnapshot(snapshot);
          const isNewer = snapshot.timestamp > this.latestTimestamp;
          if (isNewer) {
            this.latestTimestamp = snapshot.timestamp;
          }
          if (isNewer || !this.hasReceivedStreamSnapshot) {
            this.hasReceivedStreamSnapshot = true;
            this.attempt = 0;
            this.armInactivity(socket);
            this.callbacks.onState("connected");
          }
        }
      } catch (error) {
        console.error("Invalid dashboard snapshot", error);
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) socket.close();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearInactivity();
      if (!this.stopped && !this.paused) this.scheduleReconnect();
    };
  }

  private armInactivity(socket: WebSocket): void {
    this.clearInactivity();
    if (this.inactivityTimeoutMilliseconds === null) return;
    this.inactivityTimer = window.setTimeout(() => {
      this.inactivityTimer = null;
      if (this.socket !== socket || this.stopped || this.paused) return;
      this.socket = null;
      socket.close(4000, "stream inactive");
      this.scheduleReconnect();
    }, this.inactivityTimeoutMilliseconds);
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

  private clearInactivity(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }
}
