"""Build the search index (metadata.jsonl + embeddings.npy) from documents on disk.

Supported inputs: .pdf (text-based), .md, .txt  (searched recursively).
Scanned PDFs need OCR first; this script does not do OCR.
"""
import json
import os
import re
import sys
from pathlib import Path

DOCS_DIR = Path(os.getenv("RAG_DOCS_DIR", "./data/documents"))
DATA_DIR = Path(os.getenv("RAG_DATA_DIR", "./data/index"))
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "intfloat/multilingual-e5-small")
LOCAL_ONLY = os.getenv("EMBEDDING_LOCAL_ONLY", "1") == "1"
CHUNK_CHARS = int(os.getenv("CHUNK_CHARS", "900"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "150"))
MIN_CHARS = 30


def chunk(text, size=CHUNK_CHARS, overlap=CHUNK_OVERLAP):
    """Pack paragraphs into chunks of at most `size` characters; split oversized paragraphs with overlap."""
    text = re.sub(r"[ \t]+", " ", text).strip()
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, buf = [], ""
    for p in paragraphs:
        if len(p) > size:
            if buf:
                chunks.append(buf)
                buf = ""
            step = max(1, size - overlap)
            chunks += [p[i:i + size] for i in range(0, len(p), step)]
        elif len(buf) + len(p) + 2 <= size:
            buf = f"{buf}\n\n{p}" if buf else p
        else:
            chunks.append(buf)
            buf = p
    if buf:
        chunks.append(buf)
    return [c for c in chunks if len(c) >= MIN_CHARS]


def read_pages(path):
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        from pypdf import PdfReader

        for number, page in enumerate(PdfReader(str(path)).pages, start=1):
            yield number, page.extract_text() or ""
    elif suffix in {".md", ".txt"}:
        yield 1, path.read_text(encoding="utf-8")


def main():
    import numpy as np
    from sentence_transformers import SentenceTransformer

    files = sorted(p for p in DOCS_DIR.rglob("*") if p.suffix.lower() in {".pdf", ".md", ".txt"})
    if not files:
        sys.exit(f"No .pdf/.md/.txt files found in {DOCS_DIR.resolve()}")

    records = []
    for path in files:
        for page, text in read_pages(path):
            for piece in chunk(text):
                records.append({"source": path.name, "page": page, "text": piece})
        print(f"read {path.name}")

    if not records:
        sys.exit("No text could be extracted (scanned PDFs need OCR first).")

    print(f"{len(records)} chunks from {len(files)} files; embedding with {MODEL_NAME} ...")
    model = SentenceTransformer(MODEL_NAME, local_files_only=LOCAL_ONLY)
    vectors = model.encode(
        ["passage: " + r["text"] for r in records],
        normalize_embeddings=True,
        convert_to_numpy=True,
        batch_size=32,
        show_progress_bar=True,
    ).astype("float32")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    np.save(DATA_DIR / "embeddings.npy", vectors)
    with (DATA_DIR / "metadata.jsonl").open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"Index written to {DATA_DIR.resolve()}")


if __name__ == "__main__":
    main()
