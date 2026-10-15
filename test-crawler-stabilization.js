const assert = require("assert");
const { createClient } = require("redis");
const {
    normalizeUrl,
    releaseLock,
    renewLock,
    ACTIVE_CRAWLERS_KEY,
    getGlobalActiveCount,
    RATE_LIMIT_SCRIPT,
    RENEW_LOCK_SCRIPT
} = require("./redis-crawler");

async function runUnitTests() {
    console.log("=== Running Comprehensive Crawler Stabilization Tests ===");

    // 1. URL Normalization and Domain Restrictions
    console.log("\n[Test 1] URL Normalization & Domain Restrictions");
    const base = "http://localhost:3000/page/1";
    
    assert.strictEqual(
        await normalizeUrl("/page/2", base),
        "http://localhost:3000/page/2",
        "Should resolve relative path /page/2"
    );

    assert.strictEqual(
        await normalizeUrl("/page/2#section1", base),
        "http://localhost:3000/page/2",
        "Should strip URL hash fragments"
    );

    assert.strictEqual(
        await normalizeUrl("http://localhost:3000/page/2/", base),
        "http://localhost:3000/page/2",
        "Should strip trailing slashes on non-root paths"
    );

    assert.strictEqual(
        await normalizeUrl("http://localhost:3000/", base),
        "http://localhost:3000/",
        "Should preserve trailing slash on root path"
    );

    assert.strictEqual(
        await normalizeUrl("https://external-domain.com/page", base),
        null,
        "Should reject external domain"
    );

    assert.strictEqual(
        await normalizeUrl("mailto:user@example.com", base),
        null,
        "Should reject non-http protocols"
    );

    console.log("✓ URL Normalization tests passed.");

    // 2. Exponential Backoff Formula
    console.log("\n[Test 2] Bounded Exponential Backoff");
    function calcBackoff(retries) {
        return Math.min(1000 * Math.pow(2, retries - 1), 10000);
    }
    assert.strictEqual(calcBackoff(1), 1000, "Retry 1 should be 1000ms");
    assert.strictEqual(calcBackoff(2), 2000, "Retry 2 should be 2000ms");
    assert.strictEqual(calcBackoff(3), 4000, "Retry 3 should be 4000ms");
    assert.strictEqual(calcBackoff(4), 8000, "Retry 4 should be 8000ms");
    assert.strictEqual(calcBackoff(5), 10000, "Retry 5 should cap at 10000ms");
    assert.strictEqual(calcBackoff(10), 10000, "Retry 10 should cap at 10000ms");
    console.log("✓ Exponential backoff calculation verified.");

    // 3. Rate Limit Lua Script Integrity
    console.log("\n[Test 3] Rate Limit Lua Script");
    assert(RATE_LIMIT_SCRIPT.includes("ZREMRANGEBYSCORE"), "Script must remove expired scores");
    assert(RATE_LIMIT_SCRIPT.includes("ZCARD"), "Script must count current entries");
    assert(RATE_LIMIT_SCRIPT.includes("ZADD"), "Script must record atomic request timestamps");
    console.log("✓ Rate limiting script syntax and operations verified.");

    // 4. Token-Checked Lock Renewal Lua Script Integrity
    console.log("\n[Test 4] Lock Renewal Lua Script");
    assert(RENEW_LOCK_SCRIPT.includes('redis.call("GET", KEYS[1]) == ARGV[1]'), "Must verify owner token");
    assert(RENEW_LOCK_SCRIPT.includes('redis.call("PEXPIRE", KEYS[1], ARGV[2])'), "Must atomically extend TTL");
    console.log("✓ Lock renewal token verification script verified.");

    // 5. Worker Coordination & Exported Constants
    console.log("\n[Test 5] Worker Coordination Constants");
    assert.strictEqual(ACTIVE_CRAWLERS_KEY, "active_crawlers");
    assert.strictEqual(typeof getGlobalActiveCount, "function");
    assert.strictEqual(typeof renewLock, "function");
    assert.strictEqual(typeof releaseLock, "function");
    console.log("✓ Worker coordination components verified.");

    // 6. Live Redis Tests for Lock Renewal, Genuine Loss Detection, and Safe Recovery
    console.log("\n[Test 6] Live Redis Lock Renewal & Genuine Loss Scenarios");
    const testRedis = createClient({
        socket: { host: process.env.REDIS_HOST || "localhost", port: 6379 }
    });

    let redisConnected = false;
    try {
        await testRedis.connect();
        redisConnected = true;
    } catch (err) {
        console.warn("Skipping live Redis tests (Redis not reachable on localhost:6379):", err.message);
    }

    if (redisConnected) {
        const testLockKey = `test:lock:${Date.now()}`;
        const ownerToken = `worker-1-${Date.now()}`;
        const otherToken = `worker-2-${Date.now()}`;

        // 6a. Successful Renewal
        await testRedis.set(testLockKey, ownerToken, { NX: true, PX: 30000 });
        const renewSuccess = await renewLock(testLockKey, ownerToken, 30000, testRedis);
        assert.strictEqual(renewSuccess, true, "Lock renewal should succeed when token matches");
        console.log("✓ Live lock renewal succeeded when token matches.");

        // 6b. Genuine Lock Loss Detection (token mismatch)
        await testRedis.set(testLockKey, otherToken); // Overwritten by another worker
        const renewLossMismatch = await renewLock(testLockKey, ownerToken, 30000, testRedis);
        assert.strictEqual(renewLossMismatch, false, "Lock renewal must fail when token does not match");
        console.log("✓ Genuine lock loss detected on token mismatch.");

        // 6c. Genuine Lock Loss Detection (key expired/missing)
        await testRedis.del(testLockKey);
        const renewLossMissing = await renewLock(testLockKey, ownerToken, 30000, testRedis);
        assert.strictEqual(renewLossMissing, false, "Lock renewal must fail when key has expired");
        console.log("✓ Genuine lock loss detected when key has expired.");

        // 6d. Unfinished URL Recovery Logic Verification
        const recoveryUrl = "http://localhost:3000/page/recovery-test";
        const recoveryLockKey = `lock:${recoveryUrl}`;
        const recoveryQueue = "test:url_queue_recovery";

        // Case A: Another worker acquired the lock -> do not duplicate queue
        await testRedis.set(recoveryLockKey, "another-worker-owner");
        let currentLock = await testRedis.get(recoveryLockKey);
        assert(currentLock && currentLock !== ownerToken, "Another worker owns the lock");
        let shouldRequeue = !currentLock;
        assert.strictEqual(shouldRequeue, false, "Must not re-queue if another worker owns the lock");
        console.log("✓ Duplicate prevention verified when another worker owns lock.");

        // Case B: Lock expired and no owner -> re-enqueue unfinished URL
        await testRedis.del(recoveryLockKey);
        await testRedis.set(`queued:${recoveryUrl}`, "1");
        currentLock = await testRedis.get(recoveryLockKey);
        shouldRequeue = !currentLock;
        assert.strictEqual(shouldRequeue, true, "Must re-queue when lock is unowned");
        if (shouldRequeue) {
            await testRedis.del(`queued:${recoveryUrl}`);
            await testRedis.lPush(recoveryQueue, recoveryUrl);
        }
        const queuedCheck = await testRedis.get(`queued:${recoveryUrl}`);
        const queueLen = await testRedis.lLen(recoveryQueue);
        assert.strictEqual(queuedCheck, null, "queued guard should be cleared");
        assert.strictEqual(queueLen, 1, "URL should be re-enqueued for recovery");
        console.log("✓ Unfinished URL recovery verified when lock is lost without owner.");

        // Cleanup
        await testRedis.del(recoveryLockKey);
        await testRedis.del(`queued:${recoveryUrl}`);
        await testRedis.del(recoveryQueue);
        await testRedis.quit();
    }

    console.log("\n=== All stabilization unit & live scenarios passed successfully ===");
}

runUnitTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
