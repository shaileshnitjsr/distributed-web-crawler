# Distributed Web Crawler

A scalable, containerized web crawler built with Node.js, Redis, PostgreSQL, and Docker.

The crawler uses Redis as a shared URL queue and coordinates multiple crawler workers to fetch and process web pages concurrently. Crawled page metadata is stored in PostgreSQL.

## Architecture

```text
                         Test Web Server
                                |
                                | HTTP
                                v
                     +----------------------+
                     |   Crawler Workers    |
                     |                      |
                     | Worker 1             |
                     | Worker 2             |
                     | Worker 3             |
                     +----------+-----------+
                                |
                                v
                         +-------------+
                         |    Redis    |
                         |             |
                         | URL Queue   |
                         | Deduplication|
                         +------+------+
                                |
                                v
                         +-------------+
                         | PostgreSQL  |
                         |             |
                         |    pages    |
                         +-------------+
Features
Concurrent web crawling
Multiple crawler workers
Redis-based distributed URL queue
URL deduplication
Redis-based rate limiting
robots.txt support
Automatic retry handling
HTML parsing with Cheerio
HTTP requests using Undici
PostgreSQL persistence
Docker containerization
Docker Compose orchestration
Multiple crawler replicas
Persistent PostgreSQL storage
Tech Stack
Node.js
Undici — HTTP client
Cheerio — HTML parsing
Redis — distributed queue and coordination
PostgreSQL — persistent storage
Docker
Docker Compose
Database

Each crawled page is stored in the pages table.

Column	Description
id	Unique page ID
url	Crawled URL
title	Page title
status_code	HTTP response status
crawled_at	Crawl timestamp
Running Locally
1. Install dependencies
npm install
2. Start Redis

Make sure Redis is running locally.

3. Start PostgreSQL

Make sure PostgreSQL is running and the crawler_db database exists.

4. Start the test server
node test-server.js

The test server runs on:

http://localhost:3000
5. Run the crawler
node redis-crawler.js
Running with Docker

Build the crawler image:

docker build -t distributed-crawler .

Start the complete system:

docker compose up

The Docker setup runs:

Redis
PostgreSQL
3 crawler workers

The crawler workers communicate through the Docker network using the Redis and PostgreSQL service names.

Distributed Crawling

Multiple crawler workers share the same Redis queue.

                    Redis URL Queue
                   /       |       \
                  /        |        \
                 v         v         v
            Worker 1   Worker 2   Worker 3
                 \        |        /
                  \       |       /
                   v      v      v
                    PostgreSQL

This allows multiple workers to process URLs concurrently instead of relying on a single crawler process.

Reliability

The crawler includes retry handling for failed requests.

A failed URL can be retried up to a configured maximum number of times before the crawler gives up.

Rate Limiting

Redis is used to coordinate request rate limiting between workers.

This prevents multiple workers from overwhelming the target server.

robots.txt

Before crawling a domain, the crawler checks its robots.txt rules and avoids URLs that are disallowed for the crawler.

Results

The crawler was tested against a local website containing 50 pages.

The Dockerized system successfully:

Crawled 50 pages
Processed URLs using multiple crawler workers
Stored 50 pages in PostgreSQL
Used Redis as the shared queue
Successfully communicated between Docker containers

Verified database result:

count
-------
50
Project Structure
distributed-web-crawler/
│
├── crawler.js
├── redis-crawler.js
│
├── test-server.js
│
├── redis-test.js
├── init-redis.js
├── db-test.js
├── init-db.sql
│
├── Dockerfile
├── docker-compose.yml
│
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
Future Improvements
Crawl statistics and monitoring
Worker performance benchmarking
Better distributed scheduling
Persistent failed URL queue
Prometheus/Grafana monitoring
Configurable crawl depth
Domain-specific concurrency limits
Production deployment