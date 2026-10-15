const http = require("http");
const assert = require("assert");
const { request, Agent } = require("undici");

async function runFunctionalTests() {
    console.log("=== Running Functional Simulation Tests ===");

    // Start a mock server on an ephemeral port
    const server = http.createServer((req, res) => {
        if (req.url === "/server-error") {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal Server Error");
        } else if (req.url === "/not-found") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
        } else if (req.url === "/page-ok") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><head><title>OK Page</title></head><body><a href=\"/page-2\">Next</a></body></html>");
        } else {
            res.writeHead(200);
            res.end("OK");
        }
    });

    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const agent = new Agent({ connections: 5 });

    try {
        console.log(`\n[Test 1] HTTP 500 error detection`);
        const res500 = await request(`http://localhost:${port}/server-error`, { dispatcher: agent });
        assert.strictEqual(res500.statusCode, 500);
        console.log("✓ Server error returned statusCode 500 as expected.");

        console.log(`\n[Test 2] HTTP 404 client error detection`);
        const res404 = await request(`http://localhost:${port}/not-found`, { dispatcher: agent });
        assert.strictEqual(res404.statusCode, 404);
        console.log("✓ Client error returned statusCode 404 as expected.");

        console.log(`\n[Test 3] HTTP 200 success & HTML body reading`);
        const res200 = await request(`http://localhost:${port}/page-ok`, { dispatcher: agent });
        assert.strictEqual(res200.statusCode, 200);
        const body = await res200.body.text();
        assert(body.includes("OK Page"));
        console.log("✓ Success response parsed as expected.");

    } finally {
        server.close();
        agent.destroy();
    }

    console.log("\n=== All functional simulation tests passed ===");
}

runFunctionalTests().catch((err) => {
    console.error("Functional test error:", err);
    process.exit(1);
});
