"""Who may open which board (server mode).

Local / open mode (no Flowboard users): everything is allowed.
Server mode: a board belongs to its owner; admins can open every board;
boards made before user accounts existed (no owner) belong to the admins.
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException

from flowboard.db import get_session
from flowboard.db.models import Board, Edge, Node
from flowboard.services import users


def me():
    if not users.auth_enabled():
        return None
    return users.get_user(users.current_user_id.get())


def can_open(board: Optional[Board], user=None) -> bool:
    if board is None:
        return False
    if not users.auth_enabled():
        return True
    user = user if user is not None else me()
    if user is None:
        return False
    if user.role == "admin":
        return True
    return board.owner_user_id == user.id


def visible_in_list(board: Board, user, include_all: bool) -> bool:
    if user is None:
        return True
    if board.owner_user_id == user.id:
        return True
    if user.role == "admin":
        return include_all or board.owner_user_id is None
    return False


def require_board(board_id: int) -> Board:
    with get_session() as s:
        board = s.get(Board, board_id)
    if board is None:
        raise HTTPException(404, "board not found")
    if not can_open(board):
        raise HTTPException(403, "Flow này của người khác")
    return board


def require_node(node_id: int) -> Node:
    with get_session() as s:
        node = s.get(Node, node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    require_board(node.board_id)
    return node


def require_edge(edge_id: int) -> Edge:
    with get_session() as s:
        edge = s.get(Edge, edge_id)
    if edge is None:
        raise HTTPException(404, "edge not found")
    require_board(edge.board_id)
    return edge


def require_admin() -> None:
    """Team-wide settings (AI provider, API keys): admins only in server
    mode; anyone in local mode."""
    if not users.auth_enabled():
        return
    user = me()
    if user is None or user.role != "admin":
        raise HTTPException(403, "Chỉ quản trị viên được đổi cài đặt này")
