# Alert channels and rules

hostmon uses Expr Tracker for expression parsing, rule state, message models,
channel routing, retries, and delivery.

## Delivery flow

```text
metrics + template fields
        |
        v
Expr Tracker rule engine
        |
        v
AlertMessage
        |
        v
Lark / Slack / DingTalk / WeCom / webhook / email
```

hostmon evaluates rules, stores generated events in a durable SQLite outbox,
and commits the new firing state before attempting delivery. Every target
channel has its own delivery row. A failed channel is retried without
duplicating channels that already succeeded.

The outbox is stored beside runtime state as `reliability.db`. Event IDs are
stable across process restarts, and delivery errors are redacted before being
persisted. `hmon status` reports the pending delivery count.

## Secrets and environment mapping

Do not put webhook URLs in the repository. An external dotenv file can map
source keys to environment variables used by channels:

```toml
[alerts]
enabled = true
env_file = "/secure/path/hostmon.env"

[alerts.env]
LARK_URL = "ET_LARK_WEBHOOK_URL"
SLACK_URL = "ET_SLACK_WEBHOOK_URL"
```

```dotenv
LARK_URL=https://...
SLACK_URL=https://...
```

Only explicitly mapped keys are read from the file.

## Common channel options

Every `[[alerts.channels]]` item accepts:

| Option | Meaning |
| --- | --- |
| `type` | Backend type: `lark`, `slack`, `dingtalk`, `wecom`, `webhook`, or `email` |
| `name` | Unique routing name referenced by rules |
| `url` | Inline webhook URL; prefer `url_env` |
| `url_env` | Environment variable containing the webhook URL |
| `enabled` | Enable or disable the channel |
| `min_level` | Lowest accepted level |
| `levels` | Exact accepted levels, instead of `min_level` |
| `tags` | Deliver only messages sharing at least one tag |
| `options` | Backend-specific settings |
| `policy` | Optional per-channel delivery policy |

Levels are `debug`, `info`, `warning`, `error`, and `critical`. Recovery
messages are sent at `info`, so a channel with `min_level = "warning"` will not
receive recoveries.

## Lark

The Lark backend needs Expr Tracker's optional `slark` dependency:

```bash
python -m pip install "hostmon[lark]"
```

```toml
[[alerts.channels]]
type = "lark"
name = "lark-ops"
url_env = "ET_LARK_WEBHOOK_URL"
min_level = "info"
```

## Slack

```toml
[[alerts.channels]]
type = "slack"
name = "slack-ops"
url_env = "ET_SLACK_WEBHOOK_URL"
min_level = "warning"

[alerts.channels.options]
username = "hostmon"
channel = "#ops"
```

## DingTalk

```toml
[[alerts.channels]]
type = "dingtalk"
name = "dingtalk-ops"
url_env = "ET_DINGTALK_WEBHOOK_URL"
min_level = "warning"
```

Rule mentions are rendered as DingTalk mobile mentions.

## WeCom

```toml
[[alerts.channels]]
type = "wecom"
name = "wecom-ops"
url_env = "ET_WECOM_WEBHOOK_URL"
min_level = "warning"
```

Rule mentions are rendered through `mentioned_list`.

## Generic webhook

Without a template, hostmon sends the full Expr Tracker `AlertMessage` as JSON.
A template can shape the body:

```toml
[[alerts.channels]]
type = "webhook"
name = "incident-api"
url_env = "INCIDENT_WEBHOOK_URL"
min_level = "error"

[alerts.channels.options]
template = { source = "hostmon", title = "{title}", text = "{text}", level = "{level}" }
headers = { X-Service = "hostmon" }
```

Template fields are drawn from `AlertMessage`, including `title`, `text`,
`level`, `subtitle`, `traceback`, `fields`, `tags`, `mentions`, `link`,
`source`, `dedup_key`, and `ts`.

## Email

Email uses SMTP and does not require a webhook URL:

```toml
[[alerts.channels]]
type = "email"
name = "email-oncall"
min_level = "error"

[alerts.channels.options]
host = "localhost"
port = 25
sender = "hostmon@example.com"
to = ["oncall@example.com"]
html = true
```

Authenticated SMTP also accepts `ssl`, `tls`, `user`, and `password`. Keep
credentials outside source control and restrict the configuration file to the
current user.

## Multiple channels and rule routing

Configure as many channels as needed:

```toml
[[alerts.channels]]
type = "slack"
name = "slack-ops"
url_env = "ET_SLACK_WEBHOOK_URL"

[[alerts.channels]]
type = "email"
name = "email-oncall"
min_level = "error"

[alerts.channels.options]
host = "localhost"
to = ["oncall@example.com"]
```

If a rule omits `channels`, every matching channel receives it. Route a rule
to selected names with:

```json
{
  "alert": "disk-critical",
  "expr": "disk.percent >= 97",
  "level": "critical",
  "channels": ["slack-ops", "email-oncall"],
  "tags": ["storage"],
  "mode": "level",
  "cooldown": 900
}
```

Unknown channel names fail validation instead of silently dropping an alert.

## Delivery policy

The global policy is configured under `[alerts.policy]`:

```toml
[alerts.policy]
timeout = 10
max_retries = 3
backoff_initial = 0.5
backoff_factor = 2
backoff_max = 15
retry_on_status = [408, 429, 500, 502, 503, 504]
respect_retry_after = true
queue_size = 100
on_queue_full = "drop_oldest"
```

hostmon makes channel delivery synchronous and non-silent, and disables the
in-memory deduper/rate limiter because durable idempotency is owned by the
outbox. Expr Tracker still handles HTTP retries, `Retry-After`, and
per-channel filtering.

## Rule expressions and templates

```json
{
  "alert": "high-gpu-temperature",
  "expr": "mean(gpu.temperature_c[6]) >= 85",
  "level": "warning",
  "title": "GPU temperature high | {host}",
  "message": "Observed condition: {expr}",
  "for": 3,
  "mode": "level",
  "cooldown": 1800,
  "notify_recovery": true,
  "channels": ["slack-ops"]
}
```

Collectors may expose non-numeric template fields, such as failed Kubernetes
task names. They are available in `title` and `message`:

```json
{
  "alert": "kubernetes-task-failure",
  "expr": "k8s.failed_task_count > 0",
  "title": "Kubernetes GPU nodes {k8s_occupied_gpu_nodes:.0f}/{k8s_quota_nodes:.0f}",
  "message": "Failed tasks: {k8s_failed_tasks}\nDetails: {k8s_failed_task_details}"
}
```

Use `hmon rules test` to evaluate every rule against a fresh snapshot without
sending alerts. Use `hmon alert` for a manual delivery test.
