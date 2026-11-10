"""Live-sync state between external controllers (MCP) and the open UI.

The frontend keeps its own in-memory copy of the board. When Claude /
ChatGPT change things through the MCP server, the UI would not notice
until a page reload. This module keeps a tiny revision counter that the
MCP side bumps on every change; the frontend polls ``GET /api/sync`` and
reloads the board when ``rev`` moves.

``focus_board_id`` lets an AI ask the UI to switch to a board
("open board 3 so I can see it").
"""
from __future__ import annotations

import threading
import time
from typing import Optional

_lock = threading.Lock()
_state: dict = {
    "rev": 0,
    "board_ids": [],      # boards touched by the last bump (empty = unknown/all)
    "focus_board_id": None,
    "focus_seq": 0,
    "updated_at": 0.0,
}


def bump(board_id: Optional[int] = None) -> int:
    with _lock:
        _state["rev"] += 1
        _state["board_ids"] = [board_id] if board_id is not None else []
        _state["updated_at"] = time.time()
        return _state["rev"]


def focus(board_id: int) -> dict:
    with _lock:
        _state["focus_board_id"] = board_id
        _state["focus_seq"] += 1
        _state["rev"] += 1
        _state["board_ids"] = [board_id]
        _state["updated_at"] = time.time()
        return dict(_state)


def snapshot() -> dict:
    with _lock:
        return dict(_state)
