const { request, Agent } = require("undici");
const cheerio = require("cheerio");
const { createClient } = require("redis");
const robotsParser = require("robots-parser");
const { Pool } = require("pg");

const startUrl =
    process.env.START_URL ||
    "http://localhost:3000/page/1";

const allowedDomain =
    new URL(startUrl).hostname;

const redis = createClient({
    socket: {
        host: process.env.REDIS_HOST || "localhost",
        port: 6379
    }
});

redis.on("error", (err) => {
    console.log("Redis Error:", err);
});

const pool = new Pool({
    user: process.env.DB_USER || "shaileshdhama",
    password: process.env.DB_PASSWORD || "",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "crawler_db",
    port: Number(process.env.DB_PORT) || 5432
});

const Minio = require("minio");

const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_HOST || "minio",
    port: 9000,
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "minioadmin"
});

const agent = new Agent({
    connections: 30,
    pipelining: 1
});

const URL_QUEUE = "url_queue";

const RATE_LIMIT = 2;
const RATE_WINDOW = 1000;
const MAX_RETRIES = 3;

const robotsCache = new Map();


async function normalizeUrl(link, currentUrl) {
    try {
        const url = new URL(link, currentUrl);

        if (
            url.protocol !== "http:" &&
            url.protocol !== "https:"
        ) {
            return null;
        }

        // Remove URL fragments.
        url.hash = "";

        // Allow only the configured hostname.
        if (url.hostname !== allowedDomain) {
            return null;
        }

        // Remove trailing slashes except for the root path.
        if (url.pathname.length > 1) {
            url.pathname = url.pathname.replace(/\/+$/, "");
        }

        return url.href;
    } catch (error) {
        return null;
    }
}


async function addUrl(url) {
    // 1. Probabilistic check with RedisBloom
    let inBloom = false;
    try {
        const exists = await redis.sendCommand([
            "BF.EXISTS",
            "visited_urls",
            url
        ]);
        inBloom = Number(exists) === 1;
    } catch (err) {
        // If Bloom filter doesn't exist yet or command errors, proceed gracefully
    }

    if (inBloom) {
        // Handle potential Bloom filter false positives: verify against persistent database
        try {
            const result = await pool.query(
                "SELECT 1 FROM pages WHERE url = $1 LIMIT 1",
                [url]
            );
            if (result.rows && result.rows.length > 0) {
                console.log("Already crawled (verified in DB):", url);
                return;
            }
            console.log("Bloom positive was false positive or unpersisted; proceeding to queue:", url);
        } catch (err) {
            console.warn("Database verification error during Bloom check:", err.message);
        }
    }

    // 2. Exact deduplication guard for active session
    const key = `queued:${url}`;
    const added = await redis.set(key, "1", {
        NX: true,
        EX: 86400
    });

    if (added !== "OK") {
        console.log("Already queued:", url);
        return;
    }

    // 3. Register in Bloom filter
    try {
        await redis.sendCommand([
            "BF.ADD",
            "visited_urls",
            url
        ]);
    } catch (err) {
        console.warn("Bloom filter add error:", err.message);
    }

    // 4. Push to URL work queue with rollback on enqueue error
    try {
        await redis.lPush(URL_QUEUE, url);
        console.log("Added to queue:", url);
    } catch (queueErr) {
        // Roll back the queued guard so work is not permanently blocked
        try {
            await redis.del(key);
        } catch (_) {}
        throw queueErr;
    }
}

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
    redis.call('ZADD', key, now, member)
    return 0
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if #oldest > 0 then
        local oldestScore = tonumber(oldest[2])
        local waitTime = oldestScore + window - now
        if waitTime < 50 then waitTime = 50 end
        return waitTime
    else
        return 50
    end
end
`;

async function waitForRateLimit(domain) {
    const key = `rate_schedule:${domain}`;

    while (true) {
        const now = Date.now();
        const member = `${now}-${Math.random()}`;

        const waitTime = await redis.eval(RATE_LIMIT_SCRIPT, {
            keys: [key],
            arguments: [
                String(now),
                String(RATE_WINDOW),
                String(RATE_LIMIT),
                member
            ]
        });

        if (Number(waitTime) === 0) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, Number(waitTime)));
    }
}
async function canCrawl(url) {
    const parsedUrl =
        new URL(url);

    const domain =
        parsedUrl.origin;

    if (!robotsCache.has(domain)) {
        const robotsUrl =
            `${domain}/robots.txt`;

        try {
            const { body } =
                await request(
                    robotsUrl,
                    {
                        dispatcher: agent
                    }
                );

            const robotsText =
                await body.text();

            const robots =
                robotsParser(
                    robotsUrl,
                    robotsText
                );

            robotsCache.set(
                domain,
                robots
            );
        } catch {
            robotsCache.set(
                domain,
                null
            );
        }
    }

    const robots =
        robotsCache.get(domain);

    if (!robots) {
        return true;
    }

    return robots.isAllowed(
        url,
        "*"
    );
}

async function savePage(
    url,
    title,
    statusCode
) {
    await pool.query(
        `
        INSERT INTO pages
            (url, title, status_code)
        VALUES
            ($1, $2, $3)
        ON CONFLICT (url)
        DO UPDATE SET
            title = EXCLUDED.title,
            status_code = EXCLUDED.status_code,
            crawled_at = CURRENT_TIMESTAMP
        `,
        [
            url,
            title,
            statusCode
        ]
    );
}
async function crawl(url, options = {}) {
    const { signal, checkLockLost } = options;

    const domain = new URL(url).hostname;

    console.log("Checking robots.txt:", url);
    const allowed = await canCrawl(url);
    console.log("Robots check completed:", allowed);

    if (!allowed) {
        console.log("Blocked by robots.txt:", url);
        return;
    }

    if (checkLockLost && checkLockLost()) {
        throw new Error(`Lock lost prior to rate limiting for ${url}`);
    }

    console.log("Applying rate limit:", domain);
    await waitForRateLimit(domain);
    console.log("Rate limit passed:", domain);

    if (checkLockLost && checkLockLost()) {
        throw new Error(`Lock lost prior to HTTP fetch for ${url}`);
    }

    console.log("Crawling:", url);

    const response = await request(url, {
        dispatcher: agent,
        signal
    });

    if (response.statusCode >= 500) {
        throw new Error(`Server error HTTP ${response.statusCode} for ${url}`);
    }

    if (response.statusCode >= 400 && response.statusCode < 500) {
        console.log(`Client error HTTP ${response.statusCode}: ${url}`);
        await savePage(url, null, response.statusCode);
        try {
            await redis.del(`retry:${url}`);
        } catch (_) {}
        return;
    }

    const html = await response.body.text();

    if (checkLockLost && checkLockLost()) {
        throw new Error(`Lock lost prior to persisting response for ${url}`);
    }

    const $ = cheerio.load(html);

    const title =
        $("title").text() ||
        $("h1").first().text() ||
        null;

    const objectName =
        Buffer.from(url).toString("base64url") + ".html";

    await minioClient.putObject(
        "pages",
        objectName,
        html,
        Buffer.byteLength(html),
        {
            "Content-Type": "text/html"
        }
    );

    await savePage(url, title, response.statusCode);
    try {
        await redis.del(`retry:${url}`);
    } catch (_) {}

    let discovered = 0;

    for (const element of $("a").toArray()) {
        if (checkLockLost && checkLockLost()) {
            throw new Error(`Lock lost during link extraction for ${url}`);
        }

        const link = $(element).attr("href");

        if (!link) {
            continue;
        }

        const normalizedUrl = await normalizeUrl(link, url);

        if (normalizedUrl) {
            discovered++;
            await addUrl(normalizedUrl);
        }
    }

    console.log(`Discovered ${discovered} links from ${url}`);
}

async function ensurePagesBucket() {
    const exists = await minioClient.bucketExists("pages");

    if (exists) {
        return;
    }

    try {
        await minioClient.makeBucket("pages");
    } catch (error) {
        const createdByPeer = await minioClient.bucketExists("pages");

        if (!createdByPeer) {
            throw error;
        }
    }
}

const RENEW_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

async function renewLock(key, value, ttlMs, client = redis) {
    try {
        const result = await client.eval(RENEW_LOCK_SCRIPT, {
            keys: [key],
            arguments: [value, String(ttlMs)]
        });
        return Number(result) === 1;
    } catch (err) {
        console.error("Lock renewal error:", err.message);
        return false;
    }
}

async function releaseLock(key, value, client = redis) {
    try {
        await client.eval(
            `
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("DEL", KEYS[1])
            end
            return 0
            `,
            {
                keys: [key],
                arguments: [value]
            }
        );
    } catch (err) {
        console.error("Lock release error:", err.message);
    }
}

const ACTIVE_CRAWLERS_KEY = "active_crawlers";
let localActiveWorkers = 0;

async function getGlobalActiveCount() {
    try {
        await redis.zRemRangeByScore(ACTIVE_CRAWLERS_KEY, "-inf", Date.now());
        return await redis.zCard(ACTIVE_CRAWLERS_KEY);
    } catch (err) {
        return 0;
    }
}

async function worker(workerId = 1) {
    let idleCycles = 0;

    while (true) {
        let url;
        try {
            url = await redis.rPop(URL_QUEUE);
        } catch (popErr) {
            console.error("Redis RPOP error:", popErr.message);
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
        }

        if (!url) {
            // Queue is currently empty. Keep alive if any worker in this process is active
            if (localActiveWorkers > 0) {
                idleCycles = 0;
                await new Promise((resolve) => setTimeout(resolve, 200));
                continue;
            }

            // Keep alive if any peer container / worker is active globally across Redis
            const globalActive = await getGlobalActiveCount();
            if (globalActive > 0) {
                idleCycles = 0;
                await new Promise((resolve) => setTimeout(resolve, 200));
                continue;
            }

            // Check if queue has newly arrived work
            let qLen = 0;
            try {
                qLen = await redis.lLen(URL_QUEUE);
            } catch (err) {}

            if (qLen > 0) {
                idleCycles = 0;
                continue;
            }

            // Verify genuine completion across multiple idle cycles (10 * 300ms = 3.0s total)
            idleCycles++;
            if (idleCycles < 10) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                continue;
            }

            console.log(`Worker ${workerId} (pid ${process.pid}) exiting: crawl complete.`);
            return;
        }

        idleCycles = 0;
        localActiveWorkers++;
        console.log("Worker received URL:", url);

        const lockKey = `lock:${url}`;
        const lockValue = `${process.pid}-${workerId}-${Date.now()}-${Math.random()}`;

        // Register in active crawlers set with TTL (35s)
        try {
            await redis.zAdd(ACTIVE_CRAWLERS_KEY, {
                score: Date.now() + 35000,
                value: lockValue
            });
        } catch (err) {}

        try {
            let locked;
            try {
                locked = await redis.set(
                    lockKey,
                    lockValue,
                    {
                        NX: true,
                        PX: 30000
                    }
                );
                console.log("Lock result:", locked, "URL:", url);
            } catch (error) {
                console.error("Lock acquisition error:", error.message);
                // Return valid work item to queue on transient Redis error with backoff
                try {
                    await redis.lPush(URL_QUEUE, url);
                } catch (pushErr) {
                    console.error("Failed to requeue on lock error:", pushErr.message);
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
            }

            if (locked !== "OK") {
                console.log(
                    "Skipped locked/duplicate URL:",
                    url
                );
                // Discard duplicate queue item; do not requeue already-crawled/in-progress URL
                continue;
            }

            console.log("Lock acquired; calling crawl:", url);

            // Setup lease renewal heartbeat and abort controller
            const abortController = new AbortController();
            let lockLost = false;
            let crawlActive = true;

            const heartbeatInterval = setInterval(async () => {
                if (!crawlActive || lockLost) return;
                const renewed = await renewLock(lockKey, lockValue, 30000);
                if (!crawlActive) return; // Crawl completed while renewLock was in-flight
                if (!renewed) {
                    console.warn(`Lock ownership lost during crawl of ${url}`);
                    lockLost = true;
                    abortController.abort();
                    clearInterval(heartbeatInterval);
                } else {
                    // Also renew global active crawler lease
                    try {
                        await redis.zAdd(ACTIVE_CRAWLERS_KEY, {
                            score: Date.now() + 35000,
                            value: lockValue
                        });
                    } catch (_) {}
                }
            }, 5000);

            try {
                await crawl(url, {
                    signal: abortController.signal,
                    checkLockLost: () => lockLost
                });
            } catch (error) {
                console.log(
                    "Failed:",
                    url
                );

                console.log(
                    "Error:",
                    error.message
                );

                if (lockLost) {
                    console.warn(`Lock was lost for ${url}; recovering unfinished URL`);
                    // Check if another worker has already acquired the lock
                    try {
                        const currentLock = await redis.get(lockKey);
                        if (currentLock && currentLock !== lockValue) {
                            console.log(`URL ${url} is now locked by another worker; skipping re-queue to prevent duplicate crawl`);
                        } else {
                            // Lock was lost/expired and no other worker has claimed it; re-enqueue so work is not lost
                            console.log(`Re-queueing unfinished URL ${url} after lock loss`);
                            await redis.del(`queued:${url}`);
                            await redis.lPush(URL_QUEUE, url);
                        }
                    } catch (recErr) {
                        console.error("Error during lock-loss recovery:", recErr.message);
                    }
                    continue;
                }

                const retryKey =
                    `retry:${url}`;

                let retries = 0;
                try {
                    retries = await redis.incr(retryKey);
                } catch (incrErr) {
                    console.error("Retry counter Redis error:", incrErr.message);
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    try { await redis.lPush(URL_QUEUE, url); } catch (_) {}
                    continue;
                }

                if (
                    retries <=
                    MAX_RETRIES
                ) {
                    // Bounded exponential backoff: 1s, 2s, 4s... max 10s
                    const backoffMs = Math.min(1000 * Math.pow(2, retries - 1), 10000);
                    console.log(
                        `Retrying ${url} ` +
                        `(${retries}/${MAX_RETRIES}) after ${backoffMs}ms backoff`
                    );

                    await new Promise((resolve) => setTimeout(resolve, backoffMs));

                    try {
                        await redis.lPush(
                            URL_QUEUE,
                            url
                        );
                    } catch (pushErr) {
                        console.error("Failed to re-push retry URL:", pushErr.message);
                    }
                } else {
                    console.log(
                        `Giving up: ${url}`
                    );

                    try {
                        await redis.del(
                            retryKey
                        );

                        // Allow future recovery of abandoned URL
                        await redis.del(
                            `queued:${url}`
                        );
                    } catch (_) {}
                }
            } finally {
                crawlActive = false;
                clearInterval(heartbeatInterval);
                if (!lockLost) {
                    await releaseLock(
                        lockKey,
                        lockValue
                    );
                }
            }
        } finally {
            try {
                await redis.zRem(ACTIVE_CRAWLERS_KEY, lockValue);
            } catch (err) {}
            localActiveWorkers--;
        }
    }
}

async function main() {
    try {
        if (!redis.isOpen) {
            await redis.connect();
        }

        console.log("Connected to Redis");
        console.log("Start URL:", startUrl);
        console.log("Allowed domain:", allowedDomain);

        await ensurePagesBucket();

        // Normalize the seed URL before queueing.
        const seedUrl = await normalizeUrl(startUrl, startUrl);

        if (seedUrl) {
            await addUrl(seedUrl);
        } else {
            throw new Error(`Invalid start URL: ${startUrl}`);
        }

        const workers = [];

        for (let i = 0; i < 30; i++) {
            workers.push(worker(i + 1));
        }

        await Promise.all(workers);

        console.log("Finished");
    } catch (error) {
        console.error("Crawler error:", error);
    } finally {
        if (redis.isOpen) {
            await redis.quit();
        }

        await pool.end();
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizeUrl,
    addUrl,
    canCrawl,
    crawl,
    waitForRateLimit,
    ensurePagesBucket,
    renewLock,
    releaseLock,
    worker,
    main,
    redis,
    pool,
    minioClient,
    ACTIVE_CRAWLERS_KEY,
    getGlobalActiveCount,
    RATE_LIMIT_SCRIPT,
    RENEW_LOCK_SCRIPT
};
