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

const agent = new Agent({
    connections: 30,
    pipelining: 1
});

const BLOOM_FILTER = "visited_urls";
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

        url.hash = "";

        if (url.hostname !== allowedDomain) {
            return null;
        }

        return url.href;

    } catch {
        return null;
    }
}

async function addUrl(url) {

    const added = await redis.set(
        `seen:${url}`,
        "1",
        {
            NX: true
        }
    );

    if (added === "OK") {
        await redis.lPush(
            URL_QUEUE,
            url
        );
    }
}

async function waitForRateLimit(domain) {

    const key = `rate:${domain}`;

    while (true) {

        const count =
            await redis.incr(key);

        if (count === 1) {
            await redis.pExpire(
                key,
                RATE_WINDOW
            );
        }

        if (count <= RATE_LIMIT) {
            return;
        }

        await new Promise(
            resolve =>
                setTimeout(resolve, 100)
        );
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

async function crawl(url) {

    const domain =
        new URL(url).hostname;

    const allowed =
        await canCrawl(url);

    if (!allowed) {

        console.log(
            "Blocked by robots.txt:",
            url
        );

        return;
    }

    await waitForRateLimit(
        domain
    );

    console.log(
        "Crawling:",
        url
    );

    const response =
        await request(
            url,
            {
                dispatcher: agent
            }
        );

    const html =
        await response.body.text();

    const $ =
        cheerio.load(html);

    const title =
        $("title").text() ||
        $("h1").first().text() ||
        null;

    await savePage(
        url,
        title,
        response.statusCode
    );

    for (
        const element
        of $("a").toArray()
    ) {

        const link =
            $(element).attr("href");

        if (!link) {
            continue;
        }

        const normalizedUrl =
            await normalizeUrl(
                link,
                url
            );

        if (normalizedUrl) {

            await addUrl(
                normalizedUrl
            );
        }
    }
}

async function worker() {

    while (true) {

        const result =
            await redis.brPop(
                URL_QUEUE,
                2
            );

        if (!result) {
            return;
        }

        const url =
            result.element;

        try {

            await crawl(url);

        } catch (error) {

            console.log(
                "Failed:",
                url
            );

            const retryKey =
                `retry:${url}`;

            const retries =
                await redis.incr(
                    retryKey
                );

            if (
                retries <=
                MAX_RETRIES
            ) {

                console.log(
                    `Retrying ${url} ` +
                    `(${retries}/${MAX_RETRIES})`
                );

                await redis.lPush(
                    URL_QUEUE,
                    url
                );

            } else {

                console.log(
                    `Giving up: ${url}`
                );

                await redis.del(
                    retryKey
                );
            }
        }
    }
}

async function main() {

    await redis.connect();

    console.log(
        "Connected to Redis"
    );

    const workers = [];

    for (
        let i = 0;
        i < 30;
        i++
    ) {

        workers.push(
            worker()
        );
    }

    await Promise.all(
        workers
    );

    await redis.quit();

    await pool.end();

    console.log(
        "Finished"
    );
}

main();