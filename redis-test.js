const { createClient } = require("redis");

const client = createClient();

client.on("error", (err) => {
    console.log("Redis Error:", err);
});

async function main() {
    await client.connect();

    console.log("Connected to Redis");

    await client.set("message", "Hello Redis");

    const value = await client.get("message");

    console.log("Redis says:", value);

    await client.quit();
}

main();