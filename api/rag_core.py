import json
import os
from pathlib import Path

import numpy as np
import requests
from sentence_transformers import SentenceTransformer

# All settings can be overridden with environment variables (see .env.example / docker-compose.yml).
DATA_DIR = Path(os.getenv("RAG_DATA_DIR", "./data/index"))
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-small")
LOCAL_ONLY = os.getenv("EMBEDDING_LOCAL_ONLY", "1") == "1"
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "http://127.0.0.1:8081").rstrip("/")
LLM_URL = f"{LLM_BASE_URL}/v1/chat/completions"
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "180"))
TOP_K = int(os.getenv("RAG_TOP_K", "5"))
MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "500"))

_model = None
_vectors = None
_records = None


def load_index():
    global _model, _vectors, _records

    if _model is not None:
        return

    vectors = np.load(DATA_DIR / "embeddings.npy")

    with (DATA_DIR / "metadata.jsonl").open("r", encoding="utf-8") as f:
        records = [json.loads(line) for line in f if line.strip()]

    if len(records) != vectors.shape[0]:
        raise ValueError(
            f"Index mismatch: {len(records)} records, {vectors.shape[0]} vectors"
        )

    model = SentenceTransformer(MODEL_NAME, local_files_only=LOCAL_ONLY)

    _vectors = vectors
    _records = records
    _model = model


def retrieve(question, k=TOP_K):
    load_index()

    query_vector = _model.encode(
        ["query: " + question],
        normalize_embeddings=True,
        convert_to_numpy=True,
    )[0]

    scores = _vectors @ query_vector
    top_indices = np.argsort(scores)[::-1][:k]

    sources = []
    context_parts = []

    for idx in top_indices:
        item = _records[int(idx)]
        source = item.get("source", "unknown")
        page = item.get("page", "unknown")
        score = float(scores[idx])
        text = item.get("text", "")

        sources.append({
            "source": source,
            "page": page,
            "score": round(score, 4),
            "text": text,
        })

        context_parts.append(
            f"[Source: {source}, Page: {page}]\n{text}"
        )

    return sources, "\n\n".join(context_parts)


def answer_question(question):
    question = question.strip()
    if not question:
        raise ValueError("Question cannot be empty.")

    sources, context = retrieve(question)

    payload = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "Answer using only the supplied document context. "
                    "Answer in Persian if the question is in Persian. "
                    "If the context lacks the answer, say there is not enough "
                    "information in the documents. Do not invent facts. "
                    "Mention relevant source filenames and page numbers."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Question:\n{question}\n\n"
                    f"Document context:\n{context}"
                ),
            },
        ],
        "max_tokens": MAX_TOKENS,
        "temperature": 0.2,
    }

    response = requests.post(LLM_URL, json=payload, timeout=LLM_TIMEOUT)
    response.raise_for_status()
    answer = response.json()["choices"][0]["message"]["content"]

    return {"answer": answer, "sources": sources}
