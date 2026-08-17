class MonitorError(RuntimeError):
    """Base error shown by the CLI."""


class ConfigError(MonitorError):
    """Invalid or unavailable monitor configuration."""


class CollectorError(MonitorError):
    """A resource collector could not produce a valid sample."""


class RuleError(MonitorError):
    """Invalid alert rule or rule state."""


class AlertError(MonitorError):
    """Alert configuration or delivery failed."""


class ServiceError(MonitorError):
    """Service installation or control failed."""
