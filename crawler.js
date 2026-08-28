const { request, Agent } = require("undici");
const cheerio = require("cheerio");

const agent = new Agent({
    connections: 30,
    pipelining: 1
});

const startUrl = "http://localhost:3000/page/1";

const queue = [];

for (let i = 1; i <= 50; i++) {
    queue.push(`http://localhost:3000/page/${i}`);
}

const visited = new Set();

const allowedDomain = new URL(startUrl).hostname;

const MAX_CONCURRENCY = 30;

function normalizeUrl(link, currentUrl) {
    try {
        const url = new URL(link, currentUrl);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
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

async function crawl(url) {
    console.log("Crawling:", url);

const { body } = await request(url, {
    dispatcher: agent
});

    const html = await body.text();

    const $ = cheerio.load(html);

    $("a").each((index, element) => {
        const link = $(element).attr("href");

        if (!link) {
            return;
        }

        const normalizedUrl = normalizeUrl(link, url);

        if (normalizedUrl && !visited.has(normalizedUrl)) {
            queue.push(normalizedUrl);
        }
    });
}

async function worker() {
    while (true) {
        const url = queue.shift();

        if (!url) {
            return;
        }

        if (visited.has(url)) {
            continue;
        }

        visited.add(url);

        try {
            await crawl(url);
        } catch (error) {
            console.log("Failed:", url);
        }
    }
}

async function main() {
    const workers = [];

    for (let i = 0; i < MAX_CONCURRENCY; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    console.log("Finished");
}

main();