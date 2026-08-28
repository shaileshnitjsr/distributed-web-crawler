const { Pool } = require("pg");

const pool = new Pool({
    user: "shaileshdhama",
    host: "localhost",
    database: "crawler_db",
    port: 5432
});

async function main() {

    try {

        const result = await pool.query("SELECT NOW()");

        console.log("Connected to PostgreSQL");
        console.log("Database time:", result.rows[0].now);

    } catch (error) {

        console.log("Database Error:", error);

    } finally {

        await pool.end();

    }
}

main();