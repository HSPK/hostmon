# hostmon

[![CI](https://github.com/HSPK/hostmon/actions/workflows/ci.yml/badge.svg)](https://github.com/HSPK/hostmon/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/hostmon.svg)](https://pypi.org/project/hostmon/)
[![Python](https://img.shields.io/pypi/pyversions/hostmon.svg)](https://pypi.org/project/hostmon/)

`hostmon` 是一个轻量、配置驱动的资源监控 Python package，主命令为 `hmon`。
本机资源始终
从 localhost 采集；可选 Kubernetes collector 只检查任务健康、GPU 节点占用和
Volcano quota，不把 K8s node 的 CPU/memory 当作本机指标。内置采集：

| Collector | 数据源 | 核心指标 |
| --- | --- | --- |
| CPU | `/proc/stat`, `/proc/loadavg` | `cpu.percent`, `cpu.load1/5/15` |
| Memory | `/proc/meminfo` | `memory.percent`, used/available/swap |
| Disk | 本地文件系统 | `disk.percent`, 每个配置路径的容量和使用率 |
| Network | `/proc/net/dev` | `network.rx_mbps`, `network.tx_mbps` 和每接口速率 |
| GPU | `nvidia-smi` | 利用率、显存、温度、功耗 |
| Pressure | `/proc/pressure` | CPU、memory、I/O PSI |
| Kubernetes | `kubectl` | 失败任务、问题 Pod、GPU 节点 `x/N` |
| K8s permissions | `kubectl auth can-i` | 命名 RBAC 检查组及逐 verb 状态 |

指标内部使用 `/`，Expr Tracker 表达式可用更易读的点号，例如
`gpu.memory_percent >= 95 or gpu.temperature_c >= 85`。

## 架构

```text
config.toml
   |
   +-- Collector registry ---- built-ins + host_monitor.collectors entry points
   |        |
   |        +-- localhost numeric metrics
   |
   +-- RuleStore (rules.json)
   |        |
   |        +-- Expr Tracker parser/evaluator/state machine
   |
   +-- AlertSender ------------ Expr Tracker channels and retry policy
   |
   +-- StateStore ------------- atomic runtime state and bounded rule window
   +-- HistoryWriter ---------- full JSONL history, UTC date/size rotation
   |
   +-- CLI / user-systemd / K9s snapshot plugin
```

采集器遵循一个很小的 `collect(previous, now) -> CollectorResult` 接口。第三方
package 可通过 `host_monitor.collectors` entry-point 注册新采集器，无需改核心。
规则每轮自动从 JSON 重载；修改规则不需要重启服务。TOML 配置变更后重启即可。

## 安装与初始化

```bash
python3.11 -m pip install hostmon

# 仅监控，不发送消息
hmon config init

# 或复用已有 Lark webhook 环境文件；文件内容仍只保存在外部
hmon config init \
  --lark-env-file /path/to/secret.env \
  --lark-env-key WEBHOOK_URL

hmon config validate
hmon snapshot
```

源码开发安装：`python3.11 -m pip install --editable '.[dev]'`。旧的
`host-monitor` 命令保留为兼容别名。

默认文件：

- 配置：`~/.config/host-monitor/config.toml`
- 规则：`~/.config/host-monitor/rules.json`
- 状态：`~/.local/state/host-monitor/state.json`
- unit：`~/.config/systemd/user/host-monitor.service`

## CLI

```bash
# 配置
hmon config path
hmon config show
hmon config validate

# 规则
hmon rules
hmon rules list --json
hmon rules validate
hmon rules test
hmon rules add high-load 'cpu.load1 > 20' --for 3 --cooldown 1800
hmon rules disable high-load
hmon rules enable high-load
hmon rules remove high-load

# 告警
hmon alert 'manual test' --title 'hostmon' --level warning

# user-systemd 生命周期；enable/disable 与 start/stop 语义分离
hmon enable
hmon start
hmon status
hmon history list
hmon history tail -n 20
hmon stop
hmon disable
# 同时停止并禁用
hmon disable --now
```

日志：

```bash
journalctl --user -u host-monitor.service -f
```

## 配置

`hmon config init` 会生成完整 TOML。主要结构：

```toml
[monitor]
interval_seconds = 10
snapshot_seconds = 1
history_size = 360
state_file = "~/.local/state/host-monitor/state.json"
rules_file = "rules.json"

[collectors.disk]
enabled = true
paths = ["/", "/data"]

[collectors.network]
enabled = true
include = ["*"]
exclude = ["lo", "docker*", "veth*", "br-*"]

[collectors.gpu]
enabled = true
command = "nvidia-smi"
optional = true

[collectors.kubernetes]
enabled = true
context = "my-cluster"
namespace = "ml-team"
queue = "ml-team"
gpu_resource = "nvidia.com/gpu"
gpus_per_node = 8
poll_interval_seconds = 60

[collectors.kubernetes_permissions]
enabled = true
poll_interval_seconds = 60

[[collectors.kubernetes_permissions.checks]]
name = "team_volcano_jobs"
context = "my-cluster"
namespace = "ml-team"
resource = "jobs.batch.volcano.sh"
verbs = ["create", "get", "list", "watch"]

[history]
enabled = true
directory = "~/.local/state/host-monitor/history"
max_file_mb = 64

[alerts]
enabled = true
env_file = "/path/to/secret.env"

[alerts.env]
WEBHOOK_URL = "ET_LARK_WEBHOOK_URL"

[[alerts.channels]]
type = "lark"
name = "lark"
url_env = "ET_LARK_WEBHOOK_URL"
min_level = "info"

[alerts.policy]
max_retries = 3
rate_limit_per_minute = 20
dedup_window = 0
async_send = false
fail_silently = false
```

Expr Tracker 本身还支持 Slack、DingTalk、WeCom、webhook 和 email channel。

## 规则

默认规则覆盖 CPU、memory、disk、network、GPU 显存/温度，以及 K8s 失败任务
和 GPU 节点占用。规则支持
Expr Tracker 的窗口函数、`for`、edge/level、cooldown、channel 路由和恢复通知：

```json
{
  "alert": "high-cpu",
  "expr": "mean(cpu.percent[6]) >= 90",
  "level": "warning",
  "for": 3,
  "mode": "level",
  "cooldown": 1800,
  "notify_recovery": true
}
```

K8s 告警标题和正文同样定义在规则 JSON 中：

```json
{
  "alert": "k8s-task-or-node-problem",
  "expr": "k8s.failed_task_count > 0 or k8s.occupied_gpu_nodes < k8s.quota_nodes",
  "title": "K8s 节点 {k8s_occupied_gpu_nodes:.0f}/{k8s_quota_nodes:.0f} | {k8s_namespace}",
  "message": "挂掉的任务：{k8s_failed_tasks}\n详情：{k8s_failed_task_details}"
}
```

规则位于 `~/.config/host-monitor/rules.json`；package 默认模板位于
`src/host_monitor/rules.py`。状态写入前先完成同步告警发送；发送失败时不会
提交 firing 状态，下一轮会重试。

完整指标长期写入 `history/metrics-YYYY-MM-DD-NNNN.jsonl`。UTC 日期变化时创建
新文件，同一天达到 `max_file_mb` 后递增分片号；默认不自动删除。运行时规则
窗口仍只保留 `history_size` 条规则引用指标，避免状态文件膨胀。

权限通知使用 edge 规则，仅在整个检查组从 denied 变为 allowed 时触发一次：

```json
{
  "alert": "volcano-job-access",
  "expr": "permission.team_volcano_jobs.allowed == 1",
  "title": "Volcano Job 权限已开通",
  "mode": "edge"
}
```

## K9s

K9s 仅作为 localhost CLI 插件入口，不参与采集。安装后，在任意 K9s 视图按
`Shift-M` 查看运行 K9s 的这台机器的实时快照：

```bash
mkdir -p ~/.config/k9s/plugins
cp k9s-plugin.yaml ~/.config/k9s/plugins/localhost-resource-monitor.yaml
```

## 测试

```bash
PYTHONPATH=src python3.11 -m unittest discover -s tests -v
```

发布流程见 [`RELEASING.md`](RELEASING.md)。
