# RVX runtime snapshot producer

Hostmon exposes full observation snapshots, not a second metric logging channel.
The independent RVX process pulls, persists, replays, and compares these states:

```text
hostmon completed cycle -> immutable snapshot buffer -> :9108/v1/snapshots/*
                                                                  ^
                                                                  | HTTP Pull
                                                    independent RVX (:9110)
```

Original collectors, alert delivery, JSONL history, Prometheus `/metrics`,
and the hostmon UI are unchanged. Hostmon does not import RVX or a native
extension, open its storage, or expose its experiment management API.

## Configuration

Enable the original HTTP server and the opt-in producer:

```toml
[prometheus]
enabled = true
host = "127.0.0.1"
port = 9108

[rvx_snapshots]
enabled = true
run_id = "<run-id>"
project = "hostmon"
experiment = "hostmon-node-a"
attempt_id = "live"
capacity = 1000
max_buffer_bytes = 67108864
```

`run_id`, `project`, and `attempt_id` are required when enabled. An omitted
experiment uses `hostmon-<hostname>`. The registered RVX Source must match
the Run, Attempt, and `hostmon` role. Capacity bounds snapshot count, and
`max_buffer_bytes` bounds retained encoded payload bytes, not total RSS.
Defaults are 1,000 snapshots and 64 MiB; the tighter bound controls retention.
The original HTTP server must be enabled to serve snapshots. Turning it off
pauses this producer without blocking monitoring or removing its configuration.
There are no consumer/storage settings in this section.

## Observation boundary

After each completed monitoring cycle, hostmon serializes:

- `host`, the complete current `metrics`, and the complete current `fields`.
- `collectors`, with public health/freshness and any declared plugin `report`
  as `document`, including its schema version and observation timestamp.
- `alerts`, containing the observed title, severity, and rendered message.

It deliberately excludes arbitrary plugin state, collector options,
configuration, rule evaluator history, outbox IDs, delivery destinations,
and credentials. A plugin's public report and rendered alert text must be
suitable for disclosure to readers of the producer endpoint.

The observation uses the completed cycle timestamp. Optional collectors may
contribute cached results: per-collector success time, age, and document time
preserve that distinction. This is not a simultaneous observation of every
collector or node. Deleting a field or document removes it from subsequent
snapshots; earlier snapshots remain immutable.

## Protocol

| GET path | Result |
| --- | --- |
| `/v1/snapshots/descriptor` | Run/Attempt/Session, role, node, PID, state schema |
| `/v1/snapshots/latest` | Last full state, or 503 before the first capture |
| `/v1/snapshots/history?after=N&limit=M` | Cursor page of retained full snapshots |

Each snapshot has `source_session_id`, `sequence`, `observed_at_ns`,
`schema_version`, `axes`, and `state`. `axes.hostmon_sample` is the monitor
sample step. `sequence` starts at zero in each fresh process-local Session;
it is not an observation timestamp or a training step.

`after` is the inclusive next sequence. `after=0` starts at the oldest retained
snapshot, not just the latest. Use each response's `next_sequence` to advance.
`dropped_before` reports an expired cursor, including a fresh cursor after
eviction. Pages contain at most 256 snapshots (default 64) and 16 MiB. They
never advance past unreturned snapshots. Future/negative cursors and invalid
limits return HTTP 400.

A full encoded snapshot must fit 4 MiB and the configured buffer byte capacity.
State nesting is bounded to 64 levels and 100,000 nodes. Non-finite numbers,
non-string object keys, unsupported values, and out-of-range integers are
rejected, not silently coerced. A capture failure adds a monitoring warning
and makes snapshot reads return 503 until a valid capture succeeds. Original
monitoring and JSONL recording continue.

The buffer stores encoded immutable bytes. HTTP latest reads reuse these bytes;
history assembles a bounded page outside the capture lock and off the HTTP
event loop. No historical state is fabricated from the numeric dashboard
buffer or old JSONL files. All protocol routes return 404 when disabled.

## Connect the independent RVX server

Create a Project, Experiment, and Run in RVX, configure the matching identity
above, then register the hostmon HTTP base URL as a Source with role `hostmon`
and the same Attempt. Use a reachable per-host address for remote collection,
not a load-balanced endpoint that mixes producer Sessions.

No special hostmon proxy or dashboard bridge is needed. The shared RVX server
pulls this producer exactly like any other Source, derives resource charts from
its snapshots, and opens a complete observation when inspecting a chart point.
The original hostmon dashboard remains on the hostmon HTTP server.

RVX is Pre-alpha: producer and consumer contracts may change without
compatibility adapters. Keep a backup and exactly one owner of its data
directory. Old scalar archives are not loaded by the snapshot-only RVX
runtime and cannot reconstruct old full states. This integration neither
deletes nor backfills existing data or the independent hostmon JSONL history.
