from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from flowboard.db import get_session
from flowboard.db.models import Board
from flowboard.services import sync as sync_state

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.get("")
def get_sync() -> dict:
    return sync_state.snapshot()


class FocusBody(BaseModel):
    board_id: int


@router.post("/focus")
def focus_board(body: FocusBody) -> dict:
    with get_session() as s:
        if not s.get(Board, body.board_id):
            raise HTTPException(404, "board not found")
    return sync_state.focus(body.board_id)


@router.post("/bump")
def bump(board_id: int | None = None) -> dict:
    return {"rev": sync_state.bump(board_id)}
