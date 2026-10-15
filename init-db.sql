CREATE TABLE IF NOT EXISTS pages (
    id SERIAL PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    title TEXT,
    status_code INTEGER,
    crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content_chunks (
    id BIGSERIAL PRIMARY KEY,
    source_url TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT,
    title TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT content_chunks_source_url_chunk_index_key UNIQUE (source_url, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_content_chunks_source_url ON content_chunks (source_url);
CREATE INDEX IF NOT EXISTS idx_content_chunks_content_hash ON content_chunks (content_hash);