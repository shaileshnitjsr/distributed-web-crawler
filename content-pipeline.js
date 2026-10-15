const crypto = require("crypto");
const cheerio = require("cheerio");
const { Pool } = require("pg");
const Minio = require("minio");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE, 10) || 800;
const DEFAULT_CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP, 10) || 150;
const DEFAULT_CONCURRENCY = parseInt(process.env.PIPELINE_CONCURRENCY, 10) || 5;
const MAX_RETRIES = parseInt(process.env.PIPELINE_RETRIES, 10) || 3;
const BUCKET_NAME = process.env.MINIO_BUCKET || "pages";

// ---------------------------------------------------------------------------
// 1. URL and Source Handling
// ---------------------------------------------------------------------------

/**
 * Safely decodes a MinIO object name (base64url-encoded URL + '.html')
 * and normalizes the resulting URL.
 * 
 * @param {string} objectName - MinIO object key (e.g., 'aHR0cDov...html')
 * @returns {string|null} - Normalized URL string, or null if invalid
 */
function decodeObjectKeyToUrl(objectName) {
    if (!objectName || typeof objectName !== "string") {
        return null;
    }

    if (!objectName.endsWith(".html")) {
        return null;
    }

    const base64Part = objectName.slice(0, -5);
    if (!base64Part) {
        return null;
    }

    try {
        const decodedUrl = Buffer.from(base64Part, "base64url").toString("utf8");
        const parsed = new URL(decodedUrl);

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }

        // Normalize trailing slashes on non-root paths and strip fragments
        parsed.hash = "";
        if (parsed.pathname.length > 1) {
            parsed.pathname = parsed.pathname.replace(/\/+$/, "");
        }

        return parsed.href;
    } catch {
        return null;
    }
}

/**
 * Resolves canonical URL from HTML metadata, falling back to source URL.
 * 
 * @param {import('cheerio').CheerioAPI} $ - Loaded Cheerio instance
 * @param {string} sourceUrl - Fallback source URL
 * @returns {string} - Canonical URL
 */
function extractCanonicalUrl($, sourceUrl) {
    try {
        const canonicalHref = $('link[rel="canonical"]').attr("href");
        if (canonicalHref) {
            const resolved = new URL(canonicalHref.trim(), sourceUrl);
            if (resolved.protocol === "http:" || resolved.protocol === "https:") {
                resolved.hash = "";
                if (resolved.pathname.length > 1) {
                    resolved.pathname = resolved.pathname.replace(/\/+$/, "");
                }
                return resolved.href;
            }
        }
    } catch {}
    return sourceUrl;
}

// ---------------------------------------------------------------------------
// 2. Content Extraction & Boilerplate Removal
// ---------------------------------------------------------------------------

/**
 * Extracts clean readable text, title, and metadata from raw HTML.
 * Preserves header/footer article text while conservatively removing
 * scripts, styles, navigation, and cookie banners.
 * 
 * @param {string} html - Raw HTML text
 * @param {string} sourceUrl - Original page URL
 * @returns {{ title: string|null, text: string, metadata: object, contentHash: string }}
 */
function extractContent(html, sourceUrl) {
    if (!html || typeof html !== "string") {
        return {
            title: null,
            text: "",
            metadata: {},
            contentHash: crypto.createHash("sha256").update("").digest("hex")
        };
    }

    const $ = cheerio.load(html, { decodeEntities: true });

    // 1. Extract Title (with hierarchical fallbacks)
    let title = $("title").first().text().trim() ||
        $('meta[property="og:title"]').attr("content") ||
        $('meta[name="twitter:title"]').attr("content") ||
        $("h1").first().text().trim() ||
        null;

    if (title) {
        title = title.replace(/\s+/g, " ").trim();
    }

    // 2. Extract Metadata
    const canonical = extractCanonicalUrl($, sourceUrl);
    const lang = $("html").attr("lang") || null;
    const description = $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        null;
    const author = $('meta[name="author"]').attr("content") || null;

    const metadata = {
        canonical_url: canonical,
        lang: lang ? lang.trim() : null,
        description: description ? description.trim() : null,
        author: author ? author.trim() : null,
        extracted_at: new Date().toISOString()
    };

    // 3. Remove non-content and boilerplate elements conservatively
    $("script, style, noscript, iframe, svg, object, embed, applet").remove();
    $("nav, [role=\"navigation\"], .navbar, .nav-menu").remove();
    $('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [role="alertdialog"]').remove();

    // 4. Extract main content (prefer semantic main/article containers if substantive)
    let container = null;
    const candidates = $("article, main, [role=\"main\"]");
    for (const el of candidates.toArray()) {
        const textLen = $(el).text().trim().length;
        if (textLen > 80) {
            container = $(el);
            break;
        }
    }

    if (!container) {
        container = $("body").length ? $("body") : $.root();
    }

    // 5. Clean and normalize whitespace
    let rawText = container.text() || "";
    // Normalize Windows/Mac line breaks
    rawText = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Normalize tabs and multiple horizontal spaces to single space
    rawText = rawText.replace(/[ \t]+/g, " ");
    // Trim individual lines
    const lines = rawText.split("\n").map(line => line.trim()).filter(line => line.length > 0);
    // Join with double newlines for paragraph boundaries
    const cleanedText = lines.join("\n\n").trim();

    // 6. Compute deterministic SHA-256 content hash
    const contentHash = crypto.createHash("sha256").update(cleanedText).digest("hex");

    return {
        title,
        text: cleanedText,
        metadata,
        contentHash
    };
}

// ---------------------------------------------------------------------------
// 3. High-Quality Boundary-Aware Chunking
// ---------------------------------------------------------------------------

/**
 * Splits text into deterministic, boundary-aware chunks with configurable overlap.
 * Prefers paragraph and sentence boundaries, avoiding arbitrary word cuts.
 * 
 * @param {string} text - Cleaned document text
 * @param {object} [options] - Chunking options
 * @param {number} [options.chunkSize] - Target maximum chunk length in characters
 * @param {number} [options.chunkOverlap] - Overlap length in characters
 * @returns {Array<{ chunk_index: number, content: string, content_hash: string }>}
 */
function chunkText(text, options = {}) {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
        return [];
    }

    const trimmed = text.trim();
    let chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    let chunkOverlap = options.chunkOverlap !== undefined ? options.chunkOverlap : DEFAULT_CHUNK_OVERLAP;

    // Safety: ensure overlap is strictly less than chunkSize to prevent infinite loops
    if (chunkOverlap >= chunkSize) {
        chunkOverlap = Math.floor(chunkSize * 0.2);
    }
    const minStep = Math.max(1, chunkSize - chunkOverlap);

    // If text fits in a single chunk
    if (trimmed.length <= chunkSize) {
        const chunkHash = crypto.createHash("sha256").update(trimmed).digest("hex");
        return [{
            chunk_index: 0,
            content: trimmed,
            content_hash: chunkHash
        }];
    }

    const chunks = [];
    let startIdx = 0;
    let chunkIndex = 0;

    while (startIdx < trimmed.length) {
        let endIdx = Math.min(startIdx + chunkSize, trimmed.length);

        // If not at the very end of the text, seek natural boundary
        if (endIdx < trimmed.length) {
            const window = trimmed.slice(startIdx, endIdx);

            // 1. Look for paragraph boundary (\n\n) in the latter half of the chunk
            const paragraphBreak = window.lastIndexOf("\n\n");
            if (paragraphBreak > chunkSize * 0.5) {
                endIdx = startIdx + paragraphBreak + 2;
            } else {
                // 2. Look for sentence boundary (. / ! / ?)
                const sentenceMatches = [...window.matchAll(/[.!?]\s+/g)];
                if (sentenceMatches.length > 0) {
                    const lastSentence = sentenceMatches[sentenceMatches.length - 1];
                    if (lastSentence.index > chunkSize * 0.4) {
                        endIdx = startIdx + lastSentence.index + lastSentence[0].length;
                    }
                } else {
                    // 3. Look for newline or word boundary (space)
                    const spaceBreak = window.lastIndexOf(" ");
                    if (spaceBreak > chunkSize * 0.3) {
                        endIdx = startIdx + spaceBreak + 1;
                    }
                }
            }
        }

        const rawChunk = trimmed.slice(startIdx, endIdx).trim();

        if (rawChunk.length > 0) {
            const chunkHash = crypto.createHash("sha256").update(rawChunk).digest("hex");
            chunks.push({
                chunk_index: chunkIndex++,
                content: rawChunk,
                content_hash: chunkHash
            });
        }

        if (endIdx >= trimmed.length) {
            break;
        }

        // Calculate next start index using overlap
        const nextStart = endIdx - chunkOverlap;
        // Guarantee strict forward progress by at least minStep
        startIdx = Math.max(startIdx + minStep, nextStart);
    }

    return chunks;
}

// ---------------------------------------------------------------------------
// 4. Database Transactional Ingestion & Idempotency
// ---------------------------------------------------------------------------

/**
 * Checks whether content chunks for the given URL already exist with identical content hash.
 * 
 * @param {import('pg').PoolClient} client - Database client
 * @param {string} sourceUrl - Source page URL
 * @param {string} contentHash - SHA-256 content hash of extracted text
 * @returns {Promise<boolean>} - True if already processed and unchanged
 */
async function isContentUnchanged(client, sourceUrl, contentHash) {
    const res = await client.query(
        "SELECT content_hash FROM content_chunks WHERE source_url = $1 LIMIT 1",
        [sourceUrl]
    );
    if (res.rows && res.rows.length > 0) {
        return res.rows[0].content_hash === contentHash;
    }
    return false;
}

/**
 * Replaces content chunks for a URL inside an atomic database transaction.
 * Ensures reruns are idempotent and failures never leave partial chunk sets.
 * 
 * @param {import('pg').Pool} pool - PostgreSQL pool
 * @param {string} sourceUrl - Normalized source URL
 * @param {Array<object>} chunks - Array of chunk objects
 * @param {string|null} title - Extracted title
 * @param {string} contentHash - Full-document content hash
 * @param {object} metadata - Document metadata
 * @returns {Promise<number>} - Count of chunks stored
 */
async function storeChunksTransactional(pool, sourceUrl, chunks, title, contentHash, metadata) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Safely remove existing chunks for this source URL
        await client.query("DELETE FROM content_chunks WHERE source_url = $1", [sourceUrl]);

        // Insert new chunks
        for (const chunk of chunks) {
            await client.query(
                `INSERT INTO content_chunks 
                    (source_url, chunk_index, content, content_hash, title, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    sourceUrl,
                    chunk.chunk_index,
                    chunk.content,
                    contentHash,
                    title,
                    JSON.stringify(metadata)
                ]
            );
        }

        await client.query("COMMIT");
        return chunks.length;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// 5. MinIO Reading with Exponential Backoff Retries
// ---------------------------------------------------------------------------

/**
 * Reads an object from MinIO with retry and exponential backoff for transient network errors.
 * 
 * @param {Minio.Client} minioClient - MinIO client instance
 * @param {string} bucket - Bucket name
 * @param {string} objectName - Object key
 * @returns {Promise<string>} - Object content as UTF-8 string
 */
async function readMinioObjectWithRetry(minioClient, bucket, objectName) {
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
        attempt++;
        try {
            const dataStream = await minioClient.getObject(bucket, objectName);
            const chunks = [];
            for await (const chunk of dataStream) {
                chunks.push(chunk);
            }
            return Buffer.concat(chunks).toString("utf8");
        } catch (err) {
            if (attempt >= MAX_RETRIES) {
                throw new Error(`MinIO read failed after ${MAX_RETRIES} attempts: ${err.message}`);
            }
            const delay = Math.min(500 * Math.pow(2, attempt - 1), 3000);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ---------------------------------------------------------------------------
// 6. Document Processor
// ---------------------------------------------------------------------------

/**
 * Processes a single HTML object from MinIO:
 * Decodes URL, extracts content, verifies change status, chunks, and saves transactionally.
 * 
 * @param {object} params
 * @param {Minio.Client} params.minioClient
 * @param {import('pg').Pool} params.pool
 * @param {string} params.objectName
 * @param {object} [params.options]
 * @returns {Promise<{ status: 'new'|'changed'|'skipped'|'empty'|'invalid', url: string, chunks: number }>}
 */
async function processDocument({ minioClient, pool, objectName, options = {} }) {
    const sourceUrl = decodeObjectKeyToUrl(objectName);
    if (!sourceUrl) {
        return { status: "invalid", url: objectName, chunks: 0 };
    }

    const html = await readMinioObjectWithRetry(minioClient, BUCKET_NAME, objectName);
    const { title, text, metadata, contentHash } = extractContent(html, sourceUrl);

    if (!text || text.length === 0) {
        return { status: "empty", url: sourceUrl, chunks: 0 };
    }

    // Check if unchanged (unless force reprocessing is requested)
    if (!options.force) {
        const client = await pool.connect();
        try {
            const unchanged = await isContentUnchanged(client, sourceUrl, contentHash);
            if (unchanged) {
                return { status: "skipped", url: sourceUrl, chunks: 0 };
            }
        } finally {
            client.release();
        }
    }

    // Check if previously existed (to distinguish 'new' from 'changed')
    const checkClient = await pool.connect();
    let hadExisting = false;
    try {
        const res = await checkClient.query(
            "SELECT 1 FROM content_chunks WHERE source_url = $1 LIMIT 1",
            [sourceUrl]
        );
        hadExisting = res.rows && res.rows.length > 0;
    } finally {
        checkClient.release();
    }

    // Chunk text
    const chunks = chunkText(text, options);

    if (options.dryRun) {
        return {
            status: hadExisting ? "changed" : "new",
            url: sourceUrl,
            chunks: chunks.length
        };
    }

    // Store chunks transactionally
    await storeChunksTransactional(pool, sourceUrl, chunks, title, contentHash, metadata);

    return {
        status: hadExisting ? "changed" : "new",
        url: sourceUrl,
        chunks: chunks.length
    };
}

// ---------------------------------------------------------------------------
// 7. Pipeline Runner (Bounded Concurrency & Observability)
// ---------------------------------------------------------------------------

/**
 * Runs the content processing pipeline across MinIO HTML objects.
 * 
 * @param {object} [options]
 * @param {number} [options.limit] - Optional limit of documents to process
 * @param {boolean} [options.force] - Force reprocessing of unchanged content
 * @param {string} [options.singleUrl] - Process only a specific URL
 * @param {boolean} [options.dryRun] - Extract and chunk without writing to DB
 * @param {number} [options.concurrency] - Concurrency limit
 * @returns {Promise<object>} - Pipeline run statistics
 */
async function runContentPipeline(options = {}) {
    const startTime = Date.now();
    const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

    const pool = new Pool({
        user: process.env.DB_USER || "crawler",
        password: process.env.DB_PASSWORD || "crawler",
        host: process.env.DB_HOST || "localhost",
        database: process.env.DB_NAME || "crawler_db",
        port: Number(process.env.DB_PORT) || 5432
    });

    const minioClient = new Minio.Client({
        endPoint: process.env.MINIO_HOST || "localhost",
        port: Number(process.env.MINIO_PORT) || 9000,
        useSSL: false,
        accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
        secretKey: process.env.MINIO_SECRET_KEY || "minioadmin"
    });

    const stats = {
        totalObjects: 0,
        processedNew: 0,
        processedChanged: 0,
        skippedUnchanged: 0,
        emptyPages: 0,
        invalidObjects: 0,
        failed: 0,
        totalChunksWritten: 0,
        errors: []
    };

    let isInterrupted = false;
    const shutdownHandler = () => {
        if (!isInterrupted) {
            console.warn("\n[Pipeline] Interruption signal received, finishing in-flight tasks...");
            isInterrupted = true;
        }
    };
    process.once("SIGINT", shutdownHandler);
    process.once("SIGTERM", shutdownHandler);

    try {
        console.log("=== LinkMind Content Extraction & Chunking Pipeline ===");
        console.log(`Config: chunkSize=${options.chunkSize || DEFAULT_CHUNK_SIZE}, overlap=${options.chunkOverlap || DEFAULT_CHUNK_OVERLAP}, concurrency=${concurrency}`);

        // Gather candidate object names from MinIO
        const objectNames = [];

        if (options.singleUrl) {
            const encoded = Buffer.from(options.singleUrl).toString("base64url") + ".html";
            objectNames.push(encoded);
        } else {
            const stream = minioClient.listObjects(BUCKET_NAME, "", true);
            for await (const obj of stream) {
                if (obj.name && obj.name.endsWith(".html")) {
                    objectNames.push(obj.name);
                    if (options.limit && objectNames.length >= options.limit) {
                        break;
                    }
                }
            }
        }

        stats.totalObjects = objectNames.length;
        console.log(`Found ${stats.totalObjects} HTML document objects in MinIO bucket '${BUCKET_NAME}'`);

        // Bounded concurrency worker pool
        let cursor = 0;
        const worker = async () => {
            while (cursor < objectNames.length && !isInterrupted) {
                const idx = cursor++;
                const objName = objectNames[idx];

                try {
                    const result = await processDocument({
                        minioClient,
                        pool,
                        objectName: objName,
                        options
                    });

                    if (result.status === "new") {
                        stats.processedNew++;
                        stats.totalChunksWritten += result.chunks;
                    } else if (result.status === "changed") {
                        stats.processedChanged++;
                        stats.totalChunksWritten += result.chunks;
                    } else if (result.status === "skipped") {
                        stats.skippedUnchanged++;
                    } else if (result.status === "empty") {
                        stats.emptyPages++;
                    } else if (result.status === "invalid") {
                        stats.invalidObjects++;
                    }
                } catch (err) {
                    stats.failed++;
                    stats.errors.push({ objectName: objName, error: err.message });
                    console.error(`[Pipeline Error] Failed object ${objName}:`, err.message);
                }
            }
        };

        const workers = [];
        const poolSize = Math.min(concurrency, objectNames.length || 1);
        for (let i = 0; i < poolSize; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

    } finally {
        process.removeListener("SIGINT", shutdownHandler);
        process.removeListener("SIGTERM", shutdownHandler);
        await pool.end();
    }

    const durationMs = Date.now() - startTime;
    const throughput = stats.totalObjects > 0 ? (stats.totalObjects / (durationMs / 1000)).toFixed(2) : "0.00";

    stats.durationMs = durationMs;
    stats.throughput = `${throughput} obj/sec`;

    console.log("\n=== Pipeline Execution Summary ===");
    console.log(`Duration:            ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`Throughput:          ${stats.throughput}`);
    console.log(`Total Objects:       ${stats.totalObjects}`);
    console.log(`New Pages:           ${stats.processedNew}`);
    console.log(`Changed Pages:       ${stats.processedChanged}`);
    console.log(`Unchanged (Skipped): ${stats.skippedUnchanged}`);
    console.log(`Empty/Invalid:       ${stats.emptyPages + stats.invalidObjects}`);
    console.log(`Failed:              ${stats.failed}`);
    console.log(`Total Chunks Saved:  ${stats.totalChunksWritten}`);

    return stats;
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------
if (require.main === module) {
    const args = process.argv.slice(2);
    const cliOptions = {};

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--limit" && args[i + 1]) {
            cliOptions.limit = parseInt(args[++i], 10);
        } else if (args[i] === "--force") {
            cliOptions.force = true;
        } else if (args[i] === "--dry-run") {
            cliOptions.dryRun = true;
        } else if (args[i] === "--url" && args[i + 1]) {
            cliOptions.singleUrl = args[++i];
        } else if (args[i] === "--concurrency" && args[i + 1]) {
            cliOptions.concurrency = parseInt(args[++i], 10);
        }
    }

    runContentPipeline(cliOptions)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error("Fatal pipeline error:", err);
            process.exit(1);
        });
}

module.exports = {
    decodeObjectKeyToUrl,
    extractCanonicalUrl,
    extractContent,
    chunkText,
    isContentUnchanged,
    storeChunksTransactional,
    processDocument,
    runContentPipeline
};
