"""Turn a boq failure into a report a human (or another Claude) can act on.

Google reshapes Flow's internal RPCs without notice. The extension already
relearns the payload layout on its own (see docs/BOQ-MIGRATION.md), but that
only covers moved fields — a changed auth scheme or a genuinely new required
value still needs a person. When that happens the useful thing is not a stack
trace, it is a written account of *what we sent, what came back, and what the
template layer thought was going on*.

So on a `BOQ_*` failure we hand that evidence to the configured LLM CLI (the
same one Flowboard already uses for auto-prompt and vision) and let it write
the report. The file lands in ``storage/diagnostics/`` for the operator to
read, attach to an issue, or paste to whoever is doing the fixing.

Everything is redacted before it leaves this process: captcha tokens, the XSRF
token, email addresses and any long opaque blob. A diagnostic that leaks the
session it is diagnosing would be worse than no diagnostic.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flowboard.config import STORAGE_DIR

logger = logging.getLogger(__name__)

DIAGNOSTICS_DIR = STORAGE_DIR / "diagnostics"

# One report per failure burst — a broken template fails every node in a
# pipeline, and twenty identical reports help nobody.
_MIN_SECONDS_BETWEEN_REPORTS = 300.0
_last_report_at: float = 0.0

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_AT_RE = re.compile(r"(\bat=)[^&\s\"]+")
_LONG_BLOB_RE = re.compile(r"[A-Za-z0-9+/_=-]{200,}")


def _redact(value: Any) -> Any:
    """Strip anything that identifies or authenticates the session."""
    if isinstance(value, str):
        out = _LONG_BLOB_RE.sub(lambda m: f"<REDACTED_BLOB_{len(m.group(0))}_CHARS>", value)
        out = _AT_RE.sub(r"\1<REDACTED>", out)
        out = _EMAIL_RE.sub("<REDACTED_EMAIL>", out)
        return out
    if isinstance(value, dict):
        return {k: _redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


_SYSTEM_PROMPT = """You are diagnosing a failure in Flowboard, a local tool that \
drives Google Flow through the browser.

Background you can rely on:
- Google retired the aisandbox-pa REST API in Sep 2026. Flow now uses its own \
boq RPC endpoint, flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute, \
authenticated by session cookie plus an `at` XSRF token. A Chrome extension \
shims the old REST calls onto those RPCs.
- rpcids: ogiZ0b = generate/i2i, maseQ = upload, SPrCad = upscale.
- The extension learns the payload layout by observing the Flow app's own \
traffic, verifies a learned template by rebuilding the observed request \
byte-for-byte, and falls back to a hand-captured layout when nothing is learned.
- Layout drift (a moved or inserted slot) is meant to self-heal. An auth \
change, a new dynamic field, or a removed capability is NOT self-healing.

Write a short Markdown report. Be concrete and avoid hedging. Sections:
`## What failed` (one paragraph), `## Evidence` (the specific values that \
matter, quoted), `## Most likely cause` (commit to one, and say what would \
disconfirm it), `## Is this self-healable?` (yes/no and why), \
`## Suggested fix` (concrete: which file, which function, what to change).

If the evidence is too thin to reach a conclusion, say so plainly and list \
exactly what extra capture would settle it. Do not invent field positions or \
rpcids that are not in the evidence."""


def _build_prompt(evidence: dict) -> str:
    return (
        "Diagnose this Flowboard failure.\n\n```json\n"
        + json.dumps(_redact(evidence), indent=2, ensure_ascii=False)[:20000]
        + "\n```\n"
    )


async def write_report(evidence: dict) -> Optional[Path]:
    """Generate and save a diagnostic report. Never raises."""
    global _last_report_at
    now = asyncio.get_event_loop().time()
    if now - _last_report_at < _MIN_SECONDS_BETWEEN_REPORTS:
        logger.debug("boq_doctor: within cooldown, skipping report")
        return None
    _last_report_at = now

    try:
        from flowboard.services.llm.registry import run_llm
    except Exception as exc:  # noqa: BLE001
        logger.warning("boq_doctor: LLM layer unavailable: %s", exc)
        return None

    try:
        text = await run_llm(
            "planner",
            _build_prompt(evidence),
            system_prompt=_SYSTEM_PROMPT,
            timeout=120.0,
        )
    except Exception as exc:  # noqa: BLE001
        # No provider configured, CLI missing, model refused — all are normal
        # enough that they must not turn one failure into two.
        logger.warning("boq_doctor: report generation failed: %s", exc)
        return None

    try:
        DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        path = DIAGNOSTICS_DIR / f"boq-{stamp}.md"
        header = (
            f"# Flowboard boq failure — {stamp} UTC\n\n"
            f"*Written by the configured LLM CLI from redacted evidence. "
            f"Safe to share: captcha tokens, the `at` token and email addresses "
            f"are stripped before the model ever sees them.*\n\n"
        )
        body = (
            text.strip()
            + "\n\n---\n\n## Raw evidence (redacted)\n\n```json\n"
            + json.dumps(_redact(evidence), indent=2, ensure_ascii=False)
            + "\n```\n"
        )
        path.write_text(header + body, encoding="utf-8")
        logger.info("boq_doctor: wrote %s", path)
        return path
    except Exception as exc:  # noqa: BLE001
        logger.warning("boq_doctor: could not write report: %s", exc)
        return None


def schedule_report(evidence: dict) -> None:
    """Fire-and-forget from a sync context (the WS callback handler)."""
    try:
        asyncio.get_running_loop().create_task(write_report(evidence))
    except RuntimeError:
        logger.debug("boq_doctor: no running loop, skipping report")
