const { createClient } = require("redis");

const redis = createClient();

redis.on("error", (err) => {
    console.log("Redis Error:", err);
});

async function main() {
    await redis.connect();

    console.log("Connected to Redis");

    await redis.del("url_queue");
    await redis.del("visited_urls");

    const seenKeys = await redis.keys("seen:*");

    if (seenKeys.length > 0) {
        await redis.del(seenKeys);
    }

    const retryKeys = await redis.keys("retry:*");

    if (retryKeys.length > 0) {
        await redis.del(retryKeys);
    }

    await redis.sendCommand([
        "BF.RESERVE",
        "visited_urls",
        "0.01",
        "100000"
    ]);

    await redis.lPush(
        "url_queue",
        "http://localhost:3000/page/1"
    );

    console.log("Redis initialized");

    await redis.quit();
}

main();