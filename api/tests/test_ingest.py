import ingest


def test_short_paragraphs_are_packed_together():
    text = "First paragraph with enough characters to count.\n\nSecond paragraph, also long enough to keep."
    chunks = ingest.chunk(text, size=500, overlap=50)
    assert len(chunks) == 1
    assert "First paragraph" in chunks[0] and "Second paragraph" in chunks[0]


def test_long_paragraph_is_split_with_overlap():
    text = "x" * 1000
    chunks = ingest.chunk(text, size=400, overlap=100)
    assert len(chunks) >= 3
    assert all(len(c) <= 400 for c in chunks)


def test_persian_text_survives_and_tiny_chunks_are_dropped():
    text = "پاپیروس یک نمونه متن فارسی برای آزمایش بخش‌بندی است و باید سالم بماند.\n\nکوتاه"
    chunks = ingest.chunk(text, size=500, overlap=50)
    assert len(chunks) == 1
    assert "فارسی" in chunks[0]
