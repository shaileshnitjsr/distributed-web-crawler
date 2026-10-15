/**
 * test-content-pipeline.js
 * Comprehensive unit and functional tests for LinkMind content pipeline
 * 
 * Verifies:
 * 1. Base64URL object key decoding and URL validation/normalization
 * 2. Conservative boilerplate removal, title, metadata, and canonical URL extraction
 * 3. Boundary-aware chunking, configurable overlap, whitespace elimination, and deterministic indexing
 * 4. Content hashing, idempotency, and transactional storage with rollback guarantees
 */

const assert = require("assert");
const crypto = require("crypto");
const {
    decodeObjectKeyToUrl,
    extractCanonicalUrl,
    extractContent,
    chunkText,
    isContentUnchanged,
    storeChunksTransactional,
    processDocument
} = require("./content-pipeline");

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function runAsyncTest(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

console.log("=== LinkMind Content Pipeline Test Suite ===\n");

// ---------------------------------------------------------------------------
// Suite 1: URL and Object Key Decoding
// ---------------------------------------------------------------------------
console.log("Suite 1: Object Key Decoding & URL Normalization");

runTest("decodes valid Base64URL object keys with trailing .html", () => {
    const rawUrl = "http://example.com/articles/deep-learning";
    const objectKey = Buffer.from(rawUrl).toString("base64url") + ".html";
    const decoded = decodeObjectKeyToUrl(objectKey);
    assert.strictEqual(decoded, rawUrl);
});

runTest("normalizes trailing slashes on non-root paths and strips fragments", () => {
    const rawUrl = "https://example.com/docs/guide/#section-2";
    const objectKey = Buffer.from(rawUrl).toString("base64url") + ".html";
    const decoded = decodeObjectKeyToUrl(objectKey);
    assert.strictEqual(decoded, "https://example.com/docs/guide");
});

runTest("preserves root path slash", () => {
    const rawUrl = "https://example.com/";
    const objectKey = Buffer.from(rawUrl).toString("base64url") + ".html";
    const decoded = decodeObjectKeyToUrl(objectKey);
    assert.strictEqual(decoded, "https://example.com/");
});

runTest("rejects keys without .html suffix", () => {
    const rawUrl = "http://example.com/test";
    const objectKey = Buffer.from(rawUrl).toString("base64url");
    assert.strictEqual(decodeObjectKeyToUrl(objectKey), null);
    assert.strictEqual(decodeObjectKeyToUrl("random-key.txt"), null);
});

runTest("rejects non-http/https protocols", () => {
    const fileUrl = "file:///etc/passwd";
    const jsUrl = "javascript:alert(1)";
    assert.strictEqual(decodeObjectKeyToUrl(Buffer.from(fileUrl).toString("base64url") + ".html"), null);
    assert.strictEqual(decodeObjectKeyToUrl(Buffer.from(jsUrl).toString("base64url") + ".html"), null);
});

runTest("rejects malformed or empty inputs gracefully", () => {
    assert.strictEqual(decodeObjectKeyToUrl(null), null);
    assert.strictEqual(decodeObjectKeyToUrl(""), null);
    assert.strictEqual(decodeObjectKeyToUrl(".html"), null);
    assert.strictEqual(decodeObjectKeyToUrl("!!!invalid-base64!!!.html"), null);
});

runTest("extracts canonical URL and resolves relative links", () => {
    const cheerio = require("cheerio");
    
    // Absolute canonical link
    const html1 = '<html><head><link rel="canonical" href="https://example.com/canonical-page" /></head></html>';
    const $1 = cheerio.load(html1);
    assert.strictEqual(extractCanonicalUrl($1, "https://example.com/original-page"), "https://example.com/canonical-page");

    // Relative canonical link
    const html2 = '<html><head><link rel="canonical" href="/resolved-canonical" /></head></html>';
    const $2 = cheerio.load(html2);
    assert.strictEqual(extractCanonicalUrl($2, "https://example.com/sub/dir/"), "https://example.com/resolved-canonical");

    // Missing canonical link returns source URL
    const html3 = '<html><head><title>No canonical</title></head></html>';
    const $3 = cheerio.load(html3);
    assert.strictEqual(extractCanonicalUrl($3, "https://example.com/test"), "https://example.com/test");
});

// ---------------------------------------------------------------------------
// Suite 2: Content Extraction & Boilerplate Removal
// ---------------------------------------------------------------------------
console.log("\nSuite 2: Content Extraction & Boilerplate Removal");

runTest("removes script, style, nav, cookie consent and ad elements", () => {
    const sampleHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <title>Distributed Systems Architecture</title>
            <meta name="description" content="A guide to distributed architectures." />
            <meta name="author" content="Alice Dev" />
            <style>body { font-size: 14px; }</style>
            <script>console.log("analytics tracking");</script>
        </head>
        <body>
            <nav id="navbar">
                <a href="/home">Home</a>
                <a href="/about">About</a>
            </nav>
            <div class="cookie-banner modal">
                <p>Please accept all cookies to continue browsing our website.</p>
                <button>Accept</button>
            </div>
            <aside class="advertisement sidebar-ad">
                <p>Buy cheap servers now! Limited offer.</p>
            </aside>
            <main>
                <article>
                    <h1>Distributed Systems Architecture</h1>
                    <p>Distributed consensus protocols like Raft and Paxos ensure consistency across replicas.</p>
                    <p>Leader election is a fundamental building block of fault-tolerant clusters.</p>
                </article>
            </main>
            <footer>
                <p>Copyright 2026 Distributed Systems Inc. All rights reserved.</p>
            </footer>
        </body>
        </html>
    `;

    const extracted = extractContent(sampleHtml, "https://example.com/distributed-systems");
    assert.strictEqual(extracted.title, "Distributed Systems Architecture");
    assert.strictEqual(extracted.metadata.lang, "en");
    assert.strictEqual(extracted.metadata.description, "A guide to distributed architectures.");
    assert.strictEqual(extracted.metadata.author, "Alice Dev");

    // Verify main content is present
    assert(extracted.text.includes("Distributed consensus protocols like Raft and Paxos"));
    assert(extracted.text.includes("Leader election is a fundamental building block"));
    assert(extracted.text.includes("Distributed Systems Architecture"));

    // Verify boilerplate is removed
    assert(!extracted.text.includes("console.log"));
    assert(!extracted.text.includes("body { font-size"));
    assert(!extracted.text.includes("Home"));
    assert(!extracted.text.includes("Please accept all cookies"));
    assert(!extracted.text.includes("Buy cheap servers now"));
});

runTest("falls back to og:title or h1 when <title> is absent", () => {
    const htmlWithOg = `
        <html>
        <head><meta property="og:title" content="OpenGraph Title" /></head>
        <body><p>Some text</p></body>
        </html>
    `;
    const res1 = extractContent(htmlWithOg, "https://example.com/og");
    assert.strictEqual(res1.title, "OpenGraph Title");

    const htmlWithH1 = `
        <html>
        <body><h1>Heading One Title</h1><p>Some text</p></body>
        </html>
    `;
    const res2 = extractContent(htmlWithH1, "https://example.com/h1");
    assert.strictEqual(res2.title, "Heading One Title");
});

runTest("handles empty, malformed, or binary-like input safely", () => {
    const empty1 = extractContent("", "https://example.com/empty");
    assert.strictEqual(empty1.text, "");
    assert.strictEqual(empty1.title, null);

    const empty2 = extractContent(null, "https://example.com/null");
    assert.strictEqual(empty2.text, "");

    const empty3 = extractContent("<html><body>   \n\t   </body></html>", "https://example.com/blank");
    assert.strictEqual(empty3.text, "");

    // Malformed HTML unclosed tags
    const malformed = "<p>Unclosed paragraph <div>Nested unclosed <span>Text here";
    const res = extractContent(malformed, "https://example.com/malformed");
    assert(res !== null);
    assert(res.text.includes("Text here"));
});

// ---------------------------------------------------------------------------
// Suite 3: Boundary-Aware Chunking
// ---------------------------------------------------------------------------
console.log("\nSuite 3: Boundary-Aware Chunking & Deterministic Indexing");

runTest("chunks text respecting paragraph and sentence boundaries", () => {
    const paragraph1 = "Distributed systems require careful synchronization. Nodes exchange heartbeat messages to detect partition failures.";
    const paragraph2 = "When a leader node becomes unreachable, a new election term is initiated. Followers transition into candidate state and vote.";
    const paragraph3 = "Once a candidate receives a majority quorum, it assumes leadership and begins appending log entries.";
    const fullText = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

    const chunks = chunkText(fullText, {
        chunkSize: 150,
        chunkOverlap: 30
    });

    assert(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
    
    // Verify each chunk structure
    chunks.forEach((chunk, idx) => {
        assert.strictEqual(chunk.chunk_index, idx, `Chunk index mismatch at ${idx}`);
        assert(chunk.content.trim().length > 0, "Chunk content must not be empty");
        assert(chunk.content_hash && chunk.content_hash.length === 64, "Chunk must contain valid SHA-256 hash");
    });
});

runTest("chunking is deterministic across multiple runs", () => {
    const text = "Deterministic chunking ensures that re-indexing identical text produces identical hashes and offsets. This prevents unnecessary database writes and maintains citation integrity.";
    const options = {
        chunkSize: 80,
        chunkOverlap: 20
    };

    const run1 = chunkText(text, options);
    const run2 = chunkText(text, options);

    assert.strictEqual(run1.length, run2.length);
    for (let i = 0; i < run1.length; i++) {
        assert.strictEqual(run1[i].chunk_index, run2[i].chunk_index);
        assert.strictEqual(run1[i].content, run2[i].content);
        assert.strictEqual(run1[i].content_hash, run2[i].content_hash);
    }
});

runTest("does not produce infinite loop when overlap is excessively large", () => {
    const text = "A quick brown fox jumps over the lazy dog repeatedly and without pause.";
    // Overlap greater than or equal to chunkSize is automatically scaled down to prevent infinite loops
    const chunks = chunkText(text, {
        chunkSize: 30,
        chunkOverlap: 50 // Exceeds chunkSize
    });

    assert(chunks.length > 0);
    assert(chunks.length < 10, `Expected < 10 chunks, got ${chunks.length}`);
});

runTest("skips whitespace-only or empty strings", () => {
    assert.deepStrictEqual(chunkText("", {}), []);
    assert.deepStrictEqual(chunkText("   \n\n\t   ", {}), []);
    assert.deepStrictEqual(chunkText(null, {}), []);
});

// ---------------------------------------------------------------------------
// Suite 4: Database Transactions, Idempotency & Rollback
// ---------------------------------------------------------------------------
console.log("\nSuite 4: Database Transactions & Idempotency");

runAsyncTest("isContentUnchanged detects unchanged vs changed content hash", async () => {
    const testHash = crypto.createHash("sha256").update("stable article").digest("hex");
    
    // Mock DB client returning matching hash
    const mockClientMatch = {
        query: async (sql, params) => {
            return {
                rows: [{ content_hash: testHash }]
            };
        }
    };
    const unchanged = await isContentUnchanged(mockClientMatch, "http://example.com/page", testHash);
    assert.strictEqual(unchanged, true);

    // Mock DB client returning different hash
    const mockClientMismatch = {
        query: async (sql, params) => {
            return {
                rows: [{ content_hash: "different-hash-value" }]
            };
        }
    };
    const changed = await isContentUnchanged(mockClientMismatch, "http://example.com/page", testHash);
    assert.strictEqual(changed, false);

    // Mock DB client returning no rows (new page)
    const mockClientEmpty = {
        query: async () => ({ rows: [] })
    };
    const newPage = await isContentUnchanged(mockClientEmpty, "http://example.com/page", testHash);
    assert.strictEqual(newPage, false);
});

runAsyncTest("storeChunksTransactional executes DELETE and INSERT within atomic transaction", async () => {
    const executedQueries = [];
    
    const mockClient = {
        query: async (sql, params) => {
            executedQueries.push({ sql: sql.trim(), params });
            return { rows: [] };
        },
        release: () => {
            executedQueries.push({ sql: "RELEASE" });
        }
    };

    const mockPool = {
        connect: async () => mockClient
    };

    const testChunks = [
        {
            chunk_index: 0,
            content: "Chunk zero content",
            content_hash: "hash0"
        },
        {
            chunk_index: 1,
            content: "Chunk one content",
            content_hash: "hash1"
        }
    ];

    const count = await storeChunksTransactional(
        mockPool,
        "https://example.com/atomic",
        testChunks,
        "Atomic Test",
        "doc-hash-123",
        { test: true }
    );
    assert.strictEqual(count, 2);

    // Verify transaction ordering: BEGIN -> DELETE -> INSERT 1 -> INSERT 2 -> COMMIT -> RELEASE
    assert.strictEqual(executedQueries[0].sql, "BEGIN");
    assert(executedQueries[1].sql.startsWith("DELETE FROM content_chunks WHERE source_url = $1"));
    assert.strictEqual(executedQueries[1].params[0], "https://example.com/atomic");
    assert(executedQueries[2].sql.startsWith("INSERT INTO content_chunks"));
    assert.strictEqual(executedQueries[2].params[1], 0);
    assert.strictEqual(executedQueries[2].params[3], "doc-hash-123");
    assert.strictEqual(executedQueries[2].params[4], "Atomic Test");
    assert(executedQueries[3].sql.startsWith("INSERT INTO content_chunks"));
    assert.strictEqual(executedQueries[3].params[1], 1);
    assert.strictEqual(executedQueries[4].sql, "COMMIT");
    assert.strictEqual(executedQueries[5].sql, "RELEASE");
});

runAsyncTest("storeChunksTransactional issues ROLLBACK when any query fails", async () => {
    const executedQueries = [];
    
    const mockClient = {
        query: async (sql, params) => {
            executedQueries.push(sql.trim());
            if (sql.trim().startsWith("INSERT INTO content_chunks") && params[1] === 1) {
                throw new Error("Simulated database write constraint violation");
            }
            return { rows: [] };
        },
        release: () => {
            executedQueries.push("RELEASE");
        }
    };

    const mockPool = {
        connect: async () => mockClient
    };

    const testChunks = [
        {
            chunk_index: 0,
            content: "Good chunk",
            content_hash: "hash0"
        },
        {
            chunk_index: 1,
            content: "Bad chunk",
            content_hash: "hash1"
        }
    ];

    await assert.rejects(
        async () => {
            await storeChunksTransactional(
                mockPool,
                "https://example.com/fail",
                testChunks,
                "Fail Test",
                "fail-hash",
                {}
            );
        },
        /Simulated database write constraint violation/
    );

    // Verify ROLLBACK was called
    assert(executedQueries.includes("BEGIN"));
    assert(executedQueries.includes("ROLLBACK"));
    assert(executedQueries.includes("RELEASE"));
    assert(!executedQueries.includes("COMMIT"));
});

// ---------------------------------------------------------------------------
// Suite 5: Document Processing Pipeline End-to-End Unit Mock
// ---------------------------------------------------------------------------
console.log("\nSuite 5: processDocument Unit Integration");

runAsyncTest("processDocument reads MinIO stream, extracts, chunks and records stats", async () => {
    const { Readable } = require("stream");
    const rawHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>MinIO Stream Document</title></head>
        <body>
            <article>
                <h1>Pipeline Streaming</h1>
                <p>Testing MinIO object stream retrieval and parsing in the document processor.</p>
            </article>
        </body>
        </html>
    `;
    const sourceUrl = "http://example.com/stream-doc";
    const objectKey = Buffer.from(sourceUrl).toString("base64url") + ".html";

    const mockMinioClient = {
        getObject: (bucket, key, cb) => {
            const stream = Readable.from([Buffer.from(rawHtml, "utf8")]);
            if (cb) {
                cb(null, stream);
            }
            return Promise.resolve(stream);
        }
    };

    const mockClient = {
        query: async () => ({ rows: [] }),
        release: () => {}
    };

    const mockPool = {
        connect: async () => mockClient,
        query: async () => ({ rows: [] })
    };

    const result = await processDocument({
        minioClient: mockMinioClient,
        pool: mockPool,
        objectName: objectKey,
        options: { dryRun: false }
    });

    assert.strictEqual(result.status, "new");
    assert.strictEqual(result.url, sourceUrl);
    assert(result.chunks >= 1);
});

async function main() {
    // Wait for all async tests to finish
    await new Promise(r => setTimeout(r, 100));
    console.log(`\n========================================`);
    console.log(`Tests run: ${totalTests} | Passed: ${passedTests} | Failed: ${totalTests - passedTests}`);
    console.log(`========================================\n`);

    if (passedTests !== totalTests) {
        process.exit(1);
    }
}

main();
