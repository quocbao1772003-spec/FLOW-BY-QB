"""Which Google account owns a Flow project / media id, and per-account
board projects. See the table notes in db/models.py."""
from __future__ import annotations

import logging
from typing import Iterable, Optional

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import (
    Board,
    BoardAccountProject,
    BoardFlowProject,
    FlowProjectOwner,
    MediaOwner,
)
from flowboard.services.flow_client import account_pool

logger = logging.getLogger(__name__)


def current_account() -> Optional[str]:
    c = account_pool.current()
    if not getattr(c, "connected", False):
        return None
    key = account_pool.key_of(c)
    return None if key.startswith("profile:") else key


def _same_account(owner: Optional[str], account: Optional[str]) -> bool:
    """Unknown owner (legacy row) counts as the primary account's."""
    if account is None:
        return True
    if owner is None:
        primary = account_pool.primary
        return primary is None or primary == account
    return owner == account


def record_project(project_id: Optional[str], account: Optional[str]) -> None:
    if not project_id or not account:
        return
    with get_session() as s:
        if s.get(FlowProjectOwner, project_id) is None:
            s.add(FlowProjectOwner(project_id=project_id, account=account))
            s.commit()


def project_owner(project_id: Optional[str]) -> Optional[str]:
    if not project_id:
        return None
    with get_session() as s:
        row = s.get(FlowProjectOwner, project_id)
        return row.account if row else None


def project_usable(project_id: Optional[str], account: Optional[str] = None) -> bool:
    account = account if account is not None else current_account()
    return _same_account(project_owner(project_id), account)


def record_media(media_ids: Iterable[Optional[str]], account: Optional[str]) -> None:
    if not account:
        return
    ids = [m for m in media_ids if isinstance(m, str) and m]
    if not ids:
        return
    with get_session() as s:
        for m in ids:
            if s.get(MediaOwner, m) is None:
                s.add(MediaOwner(media_id=m, account=account))
        s.commit()


def media_owner(media_id: Optional[str]) -> Optional[str]:
    if not media_id:
        return None
    with get_session() as s:
        row = s.get(MediaOwner, media_id)
        return row.account if row else None


def media_usable(media_id: Optional[str], account: Optional[str] = None) -> bool:
    account = account if account is not None else current_account()
    return _same_account(media_owner(media_id), account)


def bound_project(board_id: int, account: Optional[str]) -> Optional[str]:
    """The board's Flow project for ``account`` if one exists already."""
    with get_session() as s:
        row = s.get(BoardFlowProject, board_id)
        if row is not None and _same_account(project_owner(row.flow_project_id), account):
            return row.flow_project_id
        if account:
            extra = s.exec(
                select(BoardAccountProject)
                .where(BoardAccountProject.board_id == board_id)
                .where(BoardAccountProject.account == account)
            ).first()
            if extra is not None:
                return extra.flow_project_id
    return None


async def ensure_board_project(board_id: int) -> tuple[str, bool]:
    """Return (flow_project_id, created) for the board under the account the
    pool currently routes to, creating a Flow project if needed."""
    from flowboard.services.flow_sdk import get_flow_sdk, is_valid_project_id

    account = current_account()
    pid = bound_project(board_id, account)
    if pid:
        return pid, False
    with get_session() as s:
        board = s.get(Board, board_id)
        if board is None:
            raise LookupError("board not found")
        name = board.name or "Untitled"
    resp = await get_flow_sdk().create_project(title=name)
    if resp.get("error"):
        raise RuntimeError(str(resp["error"]))
    new_pid = resp.get("project_id")
    if not isinstance(new_pid, str) or not is_valid_project_id(new_pid):
        raise RuntimeError("invalid project_id from Flow")
    with get_session() as s:
        again = bound_project(board_id, account)
        if again:
            return again, False
        if s.get(BoardFlowProject, board_id) is None:
            s.add(BoardFlowProject(board_id=board_id, flow_project_id=new_pid))
        else:
            s.add(BoardAccountProject(board_id=board_id, account=account or "", flow_project_id=new_pid))
        s.commit()
    record_project(new_pid, account)
    logger.info("bound board %s → flow_project %s (account %s)", board_id, new_pid, account)
    return new_pid, True


async def project_for_current(project_id: Optional[str], node_id: Optional[int] = None) -> Optional[str]:
    """``project_id`` if the account in use owns it; otherwise the matching
    project for this account (the board of ``node_id``, created on demand).
    Used where the UI hands in a project id it cached before an automatic
    account switch."""
    if project_usable(project_id):
        return project_id
    if node_id is not None:
        from flowboard.db.models import Node

        with get_session() as s:
            node = s.get(Node, node_id)
            board_id = node.board_id if node else None
        if board_id is not None:
            pid, _ = await ensure_board_project(board_id)
            return pid
    return project_id


def any_project_of(account: Optional[str]) -> Optional[str]:
    if not account:
        return None
    with get_session() as s:
        row = s.exec(
            select(FlowProjectOwner).where(FlowProjectOwner.account == account)
            .order_by(FlowProjectOwner.created_at.desc())
        ).first()
        return row.project_id if row else None


def owner_route(media_id: Optional[str], project_id: Optional[str]):
    """For calls on an existing media (upscale…): the connected account that
    owns it and a project of that account, or (None, project_id)."""
    owner = media_owner(media_id)
    if not owner or owner == current_account():
        return None, project_id
    client = account_pool.client_for_key(owner)
    if client is None:
        return None, project_id
    if project_owner(project_id) == owner:
        return client, project_id
    return client, any_project_of(owner) or project_id
