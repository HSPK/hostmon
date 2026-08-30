from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from .config import atomic_write_text
from .dashboard import MAX_HISTORY_SECONDS
from .errors import ConfigError, MonitorError


PREFERENCE_KEYS = {
    "hiddenPanels",
    "panelOrder",
    "windowSeconds",
    "activePage",
    "panelState",
    "panelColumns",
    "theme",
    "density",
    "customPanels",
    "navigationSections",
    "hiddenPages",
    "pageLabels",
    "customPages",
    "chartDefaults",
}
OPTIONAL_PREFERENCE_KEYS = {
    "navigationSections",
    "hiddenPages",
    "pageLabels",
    "customPages",
    "chartDefaults",
}


def _string(value: Any, name: str, *, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _string_list(value: Any, name: str) -> list[str]:
    if (
        not isinstance(value, list)
        or len(value) > 512
        or not all(isinstance(item, str) and 0 < len(item) <= 256 for item in value)
    ):
        raise ValueError(f"{name} must be an array of strings")
    return list(dict.fromkeys(value))


def _navigation_sections(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError("navigationSections must be an array")
    result: list[dict[str, Any]] = []
    section_ids: set[str] = set()
    assigned_pages: set[str] = set()
    for index, raw_section in enumerate(value):
        name = f"navigationSections[{index}]"
        if not isinstance(raw_section, dict):
            raise ValueError(f"{name} must be an object")
        unknown = set(raw_section) - {"id", "label", "placement", "pages"}
        if unknown:
            raise ValueError(f"{name} has unknown fields: {sorted(unknown)}")
        section_id = _string(raw_section.get("id"), f"{name}.id")
        if section_id in section_ids:
            raise ValueError(f"{name}.id must be unique")
        label = raw_section.get("label")
        if not isinstance(label, str) or len(label) > 64:
            raise ValueError(f"{name}.label must be a string up to 64 characters")
        placement = raw_section.get("placement")
        if placement not in {"main", "bottom"}:
            raise ValueError(f"{name}.placement must be main or bottom")
        pages = _string_list(raw_section.get("pages"), f"{name}.pages")
        duplicates = assigned_pages.intersection(pages)
        if duplicates:
            raise ValueError(
                f"{name}.pages contains pages assigned to another section: "
                f"{sorted(duplicates)}"
            )
        assigned_pages.update(pages)
        section_ids.add(section_id)
        result.append(
            {
                "id": section_id,
                "label": label,
                "placement": placement,
                "pages": pages,
            }
        )
    return result


def _page_labels(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or len(value) > 512:
        raise ValueError("pageLabels must be an object")
    result: dict[str, str] = {}
    for page_id, label in value.items():
        name = _string(page_id, "pageLabels key")
        result[name] = _string(label, f"pageLabels.{name}", maximum=80)
    return result


def _custom_pages(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or len(value) > 128:
        raise ValueError("customPages must be an array")
    result: list[dict[str, str]] = []
    identifiers: set[str] = set()
    for index, raw_page in enumerate(value):
        name = f"customPages[{index}]"
        if not isinstance(raw_page, dict):
            raise ValueError(f"{name} must be an object")
        unknown = set(raw_page) - {"id", "label"}
        if unknown:
            raise ValueError(f"{name} has unknown fields: {sorted(unknown)}")
        page_id = _string(raw_page.get("id"), f"{name}.id")
        if page_id in identifiers:
            raise ValueError(f"{name}.id must be unique")
        identifiers.add(page_id)
        result.append(
            {
                "id": page_id,
                "label": _string(
                    raw_page.get("label"),
                    f"{name}.label",
                    maximum=80,
                ),
            }
        )
    return result


def _chart_defaults(value: Any) -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "style": "line",
        "columnSpan": 1,
        "height": 270,
        "lineWidth": 1.5,
    }
    if value is None:
        return defaults
    if not isinstance(value, dict):
        raise ValueError("chartDefaults must be an object")
    unknown = set(value) - set(defaults)
    if unknown:
        raise ValueError(f"chartDefaults has unknown fields: {sorted(unknown)}")
    result = {**defaults, **value}
    if result["style"] not in {"line", "area"}:
        raise ValueError("chartDefaults.style must be line or area")
    if result["columnSpan"] not in {1, 2}:
        raise ValueError("chartDefaults.columnSpan must be 1 or 2")
    height = result["height"]
    if (
        isinstance(height, bool)
        or not isinstance(height, (int, float))
        or not 180 <= height <= 720
    ):
        raise ValueError("chartDefaults.height must be between 180 and 720")
    line_width = result["lineWidth"]
    if (
        isinstance(line_width, bool)
        or not isinstance(line_width, (int, float))
        or not 0.5 <= line_width <= 5
    ):
        raise ValueError("chartDefaults.lineWidth must be between 0.5 and 5")
    return result


def _custom_panel(value: Any, index: int) -> dict[str, Any]:
    name = f"customPanels[{index}]"
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    panel = dict(value)
    allowed = {
        "id",
        "type",
        "page",
        "title",
        "metrics",
        "custom",
        "series",
        "range",
        "style",
        "lineWidth",
        "height",
        "columnSpan",
        "section",
    }
    unknown = set(panel) - allowed
    if unknown:
        raise ValueError(f"{name} has unknown fields: {sorted(unknown)}")
    if panel.get("type") != "timeseries":
        raise ValueError(f"{name}.type must be timeseries")
    panel["id"] = _string(panel.get("id"), f"{name}.id")
    panel["page"] = _string(panel.get("page"), f"{name}.page")
    panel["title"] = _string(panel.get("title"), f"{name}.title")
    panel["metrics"] = _string_list(panel.get("metrics"), f"{name}.metrics")
    if not 1 <= len(panel["metrics"]) <= 8:
        raise ValueError(f"{name}.metrics must contain 1..8 entries")
    if panel.get("custom") is not True:
        raise ValueError(f"{name}.custom must be true")
    if panel.get("style") not in (None, "line", "area"):
        raise ValueError(f"{name}.style must be line or area")
    if panel.get("columnSpan") not in (None, 1, 2):
        raise ValueError(f"{name}.columnSpan must be 1 or 2")
    line_width = panel.get("lineWidth")
    if line_width is not None and (
        isinstance(line_width, bool)
        or not isinstance(line_width, (int, float))
    ):
        raise ValueError(f"{name}.lineWidth must be numeric")
    if isinstance(line_width, (int, float)) and not 0.5 <= line_width <= 5:
        panel["lineWidth"] = 1.5
    height = panel.get("height")
    if height is not None and (
        isinstance(height, bool) or not isinstance(height, (int, float))
    ):
        raise ValueError(f"{name}.height must be numeric")
    if isinstance(height, (int, float)) and height < 180:
        panel["height"] = 270
    range_value = panel.get("range")
    if range_value is not None and (
        not isinstance(range_value, list)
        or len(range_value) != 2
        or not all(
            isinstance(item, (int, float)) and not isinstance(item, bool)
            for item in range_value
        )
    ):
        raise ValueError(f"{name}.range must contain two numbers")
    series = panel.get("series")
    if series is not None and not isinstance(series, dict):
        raise ValueError(f"{name}.series must be an object")
    return panel


def _panel_state(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or len(value) > 512:
        raise ValueError("panelState must be an object")
    result: dict[str, dict[str, Any]] = {}
    for panel_id, raw_state in value.items():
        name = _string(panel_id, "panelState key")
        if not isinstance(raw_state, dict) or len(raw_state) > 64:
            raise ValueError(f"panelState.{name} must be an object")
        state: dict[str, Any] = {}
        for key, item in raw_state.items():
            field = _string(key, f"panelState.{name} key")
            if item is not None and (
                isinstance(item, (dict, list))
                or not isinstance(item, (str, int, float, bool))
            ):
                raise ValueError(
                    f"panelState.{name}.{field} must be a scalar"
                )
            state[field] = item
        result[name] = state
    return result


def validate_dashboard_preferences(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("preferences must be a JSON object")
    unknown = set(value) - PREFERENCE_KEYS
    missing = PREFERENCE_KEYS - OPTIONAL_PREFERENCE_KEYS - set(value)
    if unknown:
        raise ValueError(f"unknown preference fields: {sorted(unknown)}")
    if missing:
        raise ValueError(f"missing preference fields: {sorted(missing)}")

    window = value["windowSeconds"]
    if (
        isinstance(window, bool)
        or not isinstance(window, (int, float))
        or not 10 <= float(window) <= MAX_HISTORY_SECONDS
    ):
        raise ValueError(
            f"windowSeconds must be between 10 and {MAX_HISTORY_SECONDS}"
        )
    columns = value["panelColumns"]
    if not isinstance(columns, dict) or len(columns) > 512:
        raise ValueError("panelColumns must be an object")
    normalized_columns = {
        _string(panel, "panelColumns key"): _string_list(
            selected,
            f"panelColumns.{panel}",
        )
        for panel, selected in columns.items()
    }
    custom = value["customPanels"]
    if not isinstance(custom, list) or len(custom) > 128:
        raise ValueError("customPanels must be an array")

    theme = value["theme"]
    density = value["density"]
    if theme not in {"dark", "light", "system"}:
        raise ValueError("theme must be dark, light, or system")
    if density not in {"compact", "comfortable"}:
        raise ValueError("density must be compact or comfortable")

    return {
        "hiddenPanels": _string_list(value["hiddenPanels"], "hiddenPanels"),
        "panelOrder": _string_list(value["panelOrder"], "panelOrder"),
        "windowSeconds": float(window),
        "activePage": _string(value["activePage"], "activePage"),
        "panelState": _panel_state(value["panelState"]),
        "panelColumns": normalized_columns,
        "theme": theme,
        "density": density,
        "customPanels": [
            _custom_panel(panel, index) for index, panel in enumerate(custom)
        ],
        "navigationSections": _navigation_sections(
            value.get("navigationSections", [])
        ),
        "hiddenPages": _string_list(
            value.get("hiddenPages", []),
            "hiddenPages",
        ),
        "pageLabels": _page_labels(value.get("pageLabels", {})),
        "customPages": _custom_pages(value.get("customPages", [])),
        "chartDefaults": _chart_defaults(value.get("chartDefaults")),
    }


class DashboardPreferenceStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def load(self) -> dict[str, Any] | None:
        with self._lock:
            return self._load()

    def save(self, value: Any) -> dict[str, Any]:
        preferences = validate_dashboard_preferences(value)
        with self._lock:
            self._save(preferences)
        return preferences

    def patch(self, changes: Any) -> dict[str, Any]:
        if not isinstance(changes, dict) or not changes:
            raise ValueError("preference changes must be a non-empty object")
        unknown = set(changes) - PREFERENCE_KEYS
        if unknown:
            raise ValueError(f"unknown preference fields: {sorted(unknown)}")
        with self._lock:
            current = self._load()
            if current is None:
                raise ValueError("dashboard preferences are not initialized")
            merged = dict(current)
            for key, value in changes.items():
                if key in {"panelState", "panelColumns"}:
                    existing = merged.get(key)
                    if not isinstance(existing, dict) or not isinstance(value, dict):
                        raise ValueError(f"{key} changes must be an object")
                    nested = dict(existing)
                    for nested_key, nested_value in value.items():
                        if nested_value is None:
                            nested.pop(nested_key, None)
                        else:
                            nested[nested_key] = nested_value
                    merged[key] = nested
                else:
                    merged[key] = value
            preferences = validate_dashboard_preferences(merged)
            self._save(preferences)
            return preferences

    def _load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            preferences = validate_dashboard_preferences(payload)
            if preferences != payload:
                self._save(preferences)
            return preferences
        except (OSError, json.JSONDecodeError, ValueError) as error:
            raise MonitorError(
                f"cannot read dashboard preferences {self.path}: {error}"
            ) from error

    def _save(self, preferences: dict[str, Any]) -> None:
        content = json.dumps(
            preferences,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        try:
            atomic_write_text(self.path, content + "\n")
        except ConfigError as error:
            raise MonitorError(
                f"cannot write dashboard preferences {self.path}: {error}"
            ) from error
