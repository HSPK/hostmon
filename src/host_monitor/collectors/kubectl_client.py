from __future__ import annotations

import json
import shlex
import subprocess
from decimal import Decimal, InvalidOperation
from typing import Any

from ..errors import CollectorError


QUANTITY_SUFFIXES = {
    "": Decimal(1),
    "n": Decimal("0.000000001"),
    "u": Decimal("0.000001"),
    "m": Decimal("0.001"),
    "k": Decimal("1000"),
    "K": Decimal("1000"),
    "M": Decimal("1000000"),
    "G": Decimal("1000000000"),
    "T": Decimal("1000000000000"),
    "Ki": Decimal(1024),
    "Mi": Decimal(1024**2),
    "Gi": Decimal(1024**3),
    "Ti": Decimal(1024**4),
}


def parse_quantity(value: Any) -> Decimal:
    text = str(value).strip()
    for suffix in sorted(QUANTITY_SUFFIXES, key=len, reverse=True):
        if suffix and not text.endswith(suffix):
            continue
        number = text[: -len(suffix)] if suffix else text
        try:
            return Decimal(number) * QUANTITY_SUFFIXES[suffix]
        except InvalidOperation:
            continue
    raise CollectorError(f"invalid Kubernetes quantity: {value!r}")


class KubectlClient:
    def __init__(
        self,
        command: str,
        *,
        context: str = "",
        timeout_seconds: float = 30,
    ):
        if not isinstance(command, str) or not command.strip():
            raise ValueError("kubectl must be a non-empty command")
        self.command = tuple(shlex.split(command))
        self.context = context.strip()
        self.timeout = float(timeout_seconds)
        if self.timeout <= 0:
            raise ValueError("timeout_seconds must be positive")

    def _command(
        self,
        arguments: tuple[str, ...],
        *,
        context: str | None = None,
    ) -> list[str]:
        command = list(self.command)
        selected_context = self.context if context is None else context
        if selected_context:
            command.extend(["--context", selected_context])
        command.extend(arguments)
        return command

    def run(
        self,
        *arguments: str,
        context: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = self._command(arguments, context=context)
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=self.timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as error:
            raise CollectorError(f"cannot run {command[0]}: {error}") from error
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise CollectorError(f"kubectl failed: {detail}")
        return result

    def json(
        self,
        *arguments: str,
        context: str | None = None,
    ) -> dict[str, Any]:
        result = self.run(*arguments, context=context)
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise CollectorError("kubectl returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise CollectorError("kubectl returned a non-object JSON payload")
        return payload

    @staticmethod
    def items(payload: dict[str, Any], kind: str) -> list[dict[str, Any]]:
        items = payload.get("items")
        if not isinstance(items, list) or not all(
            isinstance(item, dict) for item in items
        ):
            raise CollectorError(f"kubectl returned an invalid {kind} list")
        return items

    def can_i(
        self,
        verb: str,
        resource: str,
        *,
        context: str = "",
        namespace: str = "",
    ) -> bool:
        arguments = ["auth", "can-i", verb, resource]
        if namespace:
            arguments.extend(["--namespace", namespace])
        command = self._command(tuple(arguments), context=context)
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=self.timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as error:
            raise CollectorError(f"cannot run {command[0]}: {error}") from error
        answer = result.stdout.strip().casefold()
        if answer == "yes":
            return True
        if answer == "no":
            return False
        detail = result.stderr.strip() or result.stdout.strip()
        raise CollectorError(
            f"kubectl auth can-i failed for {verb} {resource}: {detail}"
        )
