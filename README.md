# Distributed Web Crawler

A distributed, concurrent web crawler built with Node.js, Redis, PostgreSQL, MinIO, and Docker Compose.

The crawler uses a shared Redis frontier so that multiple crawler containers can process URLs concurrently while coordinating deduplication, distributed locking, rate limiting, and retries.

## Architecture

```text
                         ┌─────────────────────┐
                         │      Start URL      │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │       Redis         │
                         │                     │
                         │   URL Work Queue    │
                         │   Bloom Filter      │
                         │   Rate Scheduler    │
                         │   Distributed Lock  │
                         └──────────┬──────────┘
                                    │
                   ┌────────────────┼────────────────┐
                   │                │                │
                   ▼                ▼                ▼
             ┌───────────┐    ┌───────────┐    ┌───────────┐
             │ Crawler 1 │    │ Crawler 2 │    │ Crawler 3 │
             │  Workers  │    │  Workers  │    │  Workers  │
             └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
                   │                │                │
                   └────────────────┼────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
          ┌─────────────────┐             ┌─────────────────┐
          │   PostgreSQL    │             │      MinIO      │
          │ Page Metadata   │             │  HTML Storage   │
          └─────────────────┘             └─────────────────┘

Multiple crawler containers share the same Redis queue. This allows URLs to be distributed across workers instead of maintaining separate queues for each crawler.

Features
Distributed Crawling

Multiple crawler containers consume URLs from a shared Redis queue.

Redis Work Queue

Redis maintains the central url_queue used by all crawler workers.

Bloom Filter Deduplication

Redis Bloom Filter is used to avoid repeatedly adding the same URL to the crawling queue.

Distributed URL Locking

Redis SET NX PX locks ensure that only one worker processes a URL at a time when multiple workers encounter the same URL.

URL Normalization

Relative URLs are converted to absolute URLs and URL fragments are removed before processing.

Domain Restriction

The crawler only follows URLs belonging to the configured starting domain.

robots.txt Compliance

The crawler checks robots.txt before requesting pages and skips URLs disallowed for the crawler.

Distributed Rate Limiting

Redis sorted sets are used to coordinate request scheduling across workers and control request frequency.

Retry Mechanism

Network and request failures are retried automatically up to a configurable maximum number of attempts.

PostgreSQL Storage

Crawled page metadata is stored persistently in PostgreSQL.

MinIO Object Storage

The complete HTML response of successfully crawled pages is stored in MinIO.

Concurrent Workers

Each crawler container runs multiple asynchronous workers for concurrent URL processing.

Dockerized Infrastructure

Redis, PostgreSQL, MinIO, and crawler workers run as Docker containers.

Tech Stack
Technology	Purpose
Node.js	Crawler runtime
Undici	HTTP client
Cheerio	HTML parsing and link extraction
Redis	Queue, Bloom Filter, locking and rate limiting
PostgreSQL	Persistent page metadata
MinIO	HTML object storage
Docker	Containerization
Docker Compose	Service orchestration
System Design
1. URL Frontier

Redis maintains the shared URL queue:

Redis

└── url_queue
    ├── URL A
    ├── URL B
    ├── URL C
    └── URL D

All crawler containers consume URLs from this queue.

Because the queue is shared, work can be distributed between multiple crawler containers.

2. URL Deduplication

Before adding a URL to the queue, the crawler checks the Redis Bloom Filter:

visited_urls

If the URL has already been seen, it is not added again.

This reduces duplicate URLs entering the crawling frontier.

3. Distributed Locking

Workers acquire a Redis lock before processing a URL:

lock:<url>

The lock uses Redis SET NX with an expiration time.

Conceptually:

Worker 1 ──► acquire lock ──► process URL
Worker 2 ──► lock exists ───► skip URL

The lock has a TTL so that a crashed worker does not hold the URL forever.

The lock is released safely using a token check.

4. Crawling Pipeline

For every URL:

URL
 │
 ▼
Normalize URL
 │
 ▼
Check Domain
 │
 ▼
Check robots.txt
 │
 ▼
Acquire Distributed Lock
 │
 ▼
Apply Rate Limit
 │
 ▼
HTTP Request
 │
 ▼
Parse HTML
 │
 ├──────────────► Extract Title
 │
 └──────────────► Extract Links
                       │
                       ▼
                 Normalize URLs
                       │
                       ▼
                 Bloom Filter
                       │
                       ▼
                  Redis Queue
5. PostgreSQL Storage

For each successfully crawled page, the crawler stores:

url
title
status_code
crawled_at

The URL column has a uniqueness constraint to prevent duplicate database records.

6. MinIO Storage

The complete HTML response is stored in MinIO.

Each URL is converted into a deterministic object name:

<base64url-encoded-url>.html

This provides persistent storage of the actual crawled page content while PostgreSQL stores structured metadata.

Concurrency Model

Each crawler container launches multiple asynchronous workers.

Example:

Crawler Container
│
├── Worker 1
├── Worker 2
├── Worker 3
├── ...
└── Worker 30

Multiple crawler containers can share the same Redis infrastructure:

Crawler 1 ──┐
Crawler 2 ──┼──► Redis Queue
Crawler 3 ──┘

This creates two levels of concurrency:

Multiple asynchronous workers inside each crawler container.
Multiple crawler containers sharing the same Redis queue.
Rate Limiting

Redis sorted sets are used as a distributed scheduling mechanism.

The crawler maintains scheduling information for each domain:

rate_schedule:<domain>

Workers coordinate through Redis before making requests.

This prevents multiple crawler instances from independently sending requests too quickly to the same domain.

robots.txt

Before crawling a URL, the crawler checks the website's:

/robots.txt

URLs disallowed by the site's robots policy are skipped.

The crawler also caches robots.txt information to avoid repeatedly downloading the same file.

Retry Handling

Network and request failures are handled using Redis-backed retry tracking.

Retry information is stored using:

retry:<url>

A failed request is retried until:

MAX_RETRIES

is reached.

After the maximum number of attempts, the crawler gives up on that URL.

Docker Architecture

The system contains these services:

┌──────────────────────────────────────┐
│           Docker Compose             │
│                                      │
│  ┌──────────┐                        │
│  │  Redis   │◄──────────────┐        │
│  └──────────┘               │        │
│       ▲                     │        │
│       │                     │        │
│  ┌────┴────┐  ┌──────────┐  │        │
│  │Crawler 1│  │Crawler 2 │  │        │
│  └─────────┘  └──────────┘  │        │
│                             │        │
│                        ┌────┴────┐   │
│                        │Crawler 3│   │
│                        └─────────┘   │
│                                      │
│  ┌────────────┐    ┌─────────────┐  │
│  │ PostgreSQL │    │    MinIO    │  │
│  └────────────┘    └─────────────┘  │
└──────────────────────────────────────┘

Crawler containers can be scaled using Docker Compose.

Example:

docker compose up --build --scale crawler=3
Running the Project
1. Start a test website

The repository contains a local test website.

From the test-site directory:

python3 -m http.server 3000

The test website will be available at:

http://localhost:3000
2. Start the crawler infrastructure

From the project root:

docker compose up --build --scale crawler=3

The crawler will automatically add the configured START_URL to the Redis queue.

3. View crawler logs
docker compose logs -f crawler
4. Stop the system
docker compose down

Docker volumes are preserved unless explicitly removed.

Configuration

Important crawler configuration values include:

START_URL
REDIS_HOST
DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_PASSWORD
MINIO_HOST
MINIO_ACCESS_KEY
MINIO_SECRET_KEY

The starting URL and infrastructure configuration are provided through Docker Compose environment variables.

Verification

The project can be verified by checking the different infrastructure components.

Redis

Check the crawling queue:

docker compose exec redis redis-cli LLEN url_queue

Check the Bloom Filter:

docker compose exec redis redis-cli BF.EXISTS visited_urls "<URL>"
PostgreSQL

Check crawled pages:

docker compose exec postgres \
psql -U crawler -d crawler_db \
-c "SELECT COUNT(*) FROM pages;"
MinIO

List stored HTML objects:

docker compose exec minio mc alias set \
local http://localhost:9000 minioadmin minioadmin

Then:

docker compose exec minio mc ls --recursive local/pages
Fault Tolerance

The crawler contains several mechanisms for handling failures:

Network Failure
      │
      ▼
   Retry
      │
      ├── Success ──► Store Result
      │
      └── Max Retries ──► Give Up

Distributed locks also use expiration times so that crashed workers do not permanently block URLs.

Project Structure
distributed-web-crawler/
│
├── redis-crawler.js
├── package.json
├── package-lock.json
├── Dockerfile
├── docker-compose.yml
├── init-db.sql
├── test-site/
│   └── page/
│       ├── 1/
│       ├── 2/
│       └── ...
│
└── README.md
Learning Objectives

This project demonstrates practical concepts in:

Distributed systems
Concurrent programming
Message/work queues
Redis
Bloom Filters
Distributed locking
Rate limiting
Fault tolerance
Web crawling
HTTP networking
HTML parsing
PostgreSQL
Object storage
Docker
Docker Compose
Service orchestration
Future Improvements

Possible improvements include:

Crawl depth configuration
URL prioritization
Persistent failed URL queue
Better distributed scheduling
Crawl statistics
Worker performance metrics
Prometheus monitoring
Grafana dashboards
Domain-specific concurrency limits
Distributed tracing
Dynamic worker scaling
Production deployment
Large-scale external website testing