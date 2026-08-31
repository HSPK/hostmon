import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {
  ConnectionState,
  MetricSnapshot,
} from "../domain/types";
import {RealtimeClient} from "./websocket-client";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCalls: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  sendSnapshot(timestamp: number): void {
    this.onmessage?.({
      data: JSON.stringify({
        timestamp,
        host: "test-host",
        metrics: {"cpu/percent": 10},
        fields: {},
      }),
    } as MessageEvent);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({code, reason});
    this.onclose?.(new Event("close") as CloseEvent);
  }
}

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  if (!socket) throw new Error(`WebSocket ${index} was not created`);
  return socket;
}

describe("RealtimeClient", () => {
  let client: RealtimeClient | null = null;
  let states: ConnectionState[];
  let snapshots: MetricSnapshot[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "hostmon.test",
    });
    vi.stubGlobal(
      "WebSocket",
      FakeWebSocket as unknown as typeof WebSocket,
    );
    FakeWebSocket.instances = [];
    states = [];
    snapshots = [];
    client = new RealtimeClient({
      onSnapshot: snapshot => snapshots.push(snapshot),
      onState: state => states.push(state),
    });
  });

  afterEach(() => {
    client?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resets the inactivity deadline for each newer sample", () => {
    client!.configureInactivityTimeout(30, 100);
    client!.start();
    const socket = socketAt(0);
    socket.open();
    socket.sendSnapshot(101);

    vi.advanceTimersByTime(20_000);
    socket.sendSnapshot(102);
    vi.advanceTimersByTime(20_000);

    expect(socket.closeCalls).toEqual([]);
    expect(states.at(-1)).toBe("connected");
    expect(snapshots.map(snapshot => snapshot.timestamp)).toEqual([101, 102]);

    vi.advanceTimersByTime(10_000);
    expect(socket.closeCalls).toEqual([
      {code: 4000, reason: "stream inactive"},
    ]);
    expect(states.at(-1)).toBe("reconnecting");
  });

  it("reconnects proactively and ignores duplicate stale snapshots", () => {
    client!.configureInactivityTimeout(30, 100);
    client!.start();
    const first = socketAt(0);
    first.open();
    first.sendSnapshot(100);
    expect(states.at(-1)).toBe("connected");

    vi.advanceTimersByTime(30_000);
    first.sendSnapshot(102);
    expect(states.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(250);
    const second = socketAt(1);
    second.open();
    second.sendSnapshot(100);
    expect(states.at(-1)).toBe("reconnecting");

    second.sendSnapshot(102);
    expect(states.at(-1)).toBe("connected");
  });
});
