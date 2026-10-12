import logging
from contextlib import asynccontextmanager

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import rag_core

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Do not crash when the index has not been built yet: /api/health reports the problem
    # and the container stays up so you can run the ingest step.
    try:
        rag_core.load_index()
    except Exception as exc:
        logger.warning("Index not loaded at startup: %s", exc)
    yield


app = FastAPI(title="Local RAG API", lifespan=lifespan)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


@app.get("/api/health")
def health():
    try:
        rag_core.load_index()
        index_ok = True
        index_error = None
    except Exception as exc:
        index_ok = False
        index_error = str(exc)

    try:
        response = requests.get(f"{rag_core.LLM_BASE_URL}/health", timeout=3)
        qwen_ok = response.ok
    except requests.RequestException:
        qwen_ok = False

    return {
        "status": "ok" if index_ok and qwen_ok else "degraded",
        "index_loaded": index_ok,
        "index_error": index_error,
        "qwen_available": qwen_ok,
    }


@app.post("/api/chat")
def chat(body: ChatRequest):
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    try:
        return rag_core.answer_question(question)
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not reach the local Qwen model server.",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RAG processing failed: {exc}",
        ) from exc
