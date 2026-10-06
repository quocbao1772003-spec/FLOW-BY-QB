"""Side-panel AI chat (product naming / prompt writing) over the claude CLI.

POST /api/ai-chat/stream → text/event-stream of JSON lines:
  data: {"type": "delta", "text": "..."}
  data: {"type": "done", "model": "..."}
  data: {"type": "error", "message": "..."}
Closing the request (Stop button) kills the CLI process.
"""
from __future__ import annotations

import json
from typing import List, Literal, Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from flowboard.services import ai_chat

router = APIRouter(tags=["ai-chat"])


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=20000)


class AiChatRequest(BaseModel):
    messages: List[ChatTurn] = Field(min_length=1, max_length=200)
    model: Literal["sonnet", "opus", "haiku"] = "sonnet"
    context: Optional[str] = Field(default=None, max_length=12000)
    attachments: List[str] = Field(default_factory=list, max_length=6)


@router.post("/api/ai-chat/stream")
async def ai_chat_stream(body: AiChatRequest):
    async def gen():
        async for ev in ai_chat.stream_reply(
            [m.model_dump() for m in body.messages],
            model=body.model,
            context=body.context,
            attachment_ids=body.attachments,
        ):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/ai-chat/models")
def ai_chat_models():
    return {
        "default": ai_chat.DEFAULT_MODEL,
        "models": [
            {"key": "sonnet", "label": "Sonnet 5.5", "hint": "Nhanh, tiết kiệm"},
            {"key": "opus", "label": "Opus 5.5", "hint": "Mạnh nhất, tốn hơn"},
            {"key": "haiku", "label": "Haiku 4.5", "hint": "Nhanh nhất, rẻ nhất"},
        ],
    }
