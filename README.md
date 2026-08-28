# 🚀 Distributed Web Crawler

A fault-tolerant, Dockerized distributed web crawler built with **Node.js, Redis, PostgreSQL, Docker, Undici, and Cheerio**.

The system distributes URL crawling across multiple worker processes using **Redis as a shared work queue**, while PostgreSQL provides persistent storage for crawled page metadata.

The crawler supports URL deduplication, robots.txt compliance, distributed rate limiting, retries, URL normalization, and concurrent worker execution.

---

## 📌 Overview

Traditional web crawlers often run as a single process, which limits throughput and makes scaling difficult.

This project implements a distributed architecture where multiple crawler workers consume URLs from a shared Redis queue.

```text
                         ┌─────────────────────┐
                         │      Seed URL       │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │        Redis        │
                         │    URL Work Queue   │
                         └──────────┬──────────┘
                                    │
                   ┌────────────────┼────────────────┐
                   │                │                │
                   ▼                ▼                ▼
             ┌───────────┐    ┌───────────┐    ┌───────────┐
             │ Crawler 1 │    │ Crawler 2 │    │ Crawler 3 │
             └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
                   │                │                │
                   └────────────────┼────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │     PostgreSQL      │
                         │  Crawled Page Data  │
                         └─────────────────────┘

Each crawler worker independently retrieves URLs from the shared queue and processes them concurrently.

✨ Features
Distributed Crawling

Multiple crawler containers consume URLs from a shared Redis queue.

Redis Work Queue

Redis provides the central URL queue used by all crawler workers.

URL Deduplication

Redis SET NX operations prevent the same URL from being processed multiple times.

URL Normalization

Relative URLs are converted to absolute URLs and fragments are removed before processing.

Domain Restriction

The crawler only follows URLs belonging to the configured starting domain.

robots.txt Compliance

The crawler checks robots.txt before requesting pages and skips URLs disallowed for the crawler.

Distributed Rate Limiting

Redis coordinates request rate limiting across workers to prevent excessive requests to the target server.

Retry Mechanism

Failed URLs are retried automatically up to a configurable maximum number of attempts.

PostgreSQL Storage

Crawled page metadata is stored persistently in PostgreSQL.

Concurrent Workers

Each crawler container runs multiple asynchronous workers, allowing concurrent URL processing.

Dockerized Infrastructure

Redis, PostgreSQL, and crawler workers run as Docker containers and can be scaled using Docker Compose.

🛠️ Tech Stack
Technology	Purpose
Node.js	Crawler runtime
Undici	High-performance HTTP client
Cheerio	HTML parsing and link extraction
Redis	Distributed URL queue, deduplication and rate limiting
PostgreSQL	Persistent crawl data storage
Docker	Containerization
Docker Compose	Multi-container orchestration
🧠 System Design
1. URL Queue

Redis maintains the shared crawling queue:

Redis
└── url_queue
    ├── URL A
    ├── URL B
    ├── URL C
    └── URL D

All crawler workers consume URLs from this same queue.

This allows workers to distribute the workload automatically.

2. URL Deduplication

Before adding a URL to the queue, the crawler creates a Redis key:

seen:<url>

The URL is inserted only if the key does not already exist.

This prevents duplicate crawling when multiple pages contain links to the same URL.

3. Crawling Pipeline

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
                 Redis Queue
                       │
                       ▼
                  Next Worker
4. PostgreSQL Storage

Each successfully crawled page is stored with:

url
title
status_code
crawled_at

Duplicate database entries are prevented using the URL constraint.

⚡ Concurrency Model

Each crawler container launches multiple asynchronous workers.

For example:

Crawler Container
│
├── Worker 1
├── Worker 2
├── Worker 3
├── ...
└── Worker 30

Multiple crawler containers can then be launched:

Crawler 1 → Workers
Crawler 2 → Workers
Crawler 3 → Workers
        │
        ▼
      Redis

This provides two levels of concurrency:

Multiple workers within each crawler container
Multiple crawler containers sharing the Redis queue
🔒 Rate Limiting

Redis is used to coordinate request rate limiting between workers.

The crawler maintains a Redis counter for each domain and limits the number of requests within a configured time window.

This prevents multiple workers from overwhelming the target server.

🤖 robots.txt

Before crawling a URL, the crawler checks the corresponding:

/robots.txt

If crawling is disallowed, the URL is skipped.

This helps the crawler follow website crawling policies.

🔄 Retry Handling

Network failures and request errors are handled using a retry mechanism.

The crawler tracks retries using Redis:

retry:<url>

A failed URL is retried until:

MAX_RETRIES

is reached.

After that, the crawler gives up on the URL.

🐳 Docker Architecture

The application consists of three main services:

┌─────────────────────────────────────┐
│           Docker Compose            │
│                                     │
│  ┌────────────┐                     │
│  │   Redis    │                     │
│  └─────┬──────┘                     │
│        │                             │
│  ┌─────┴───────────────────────┐    │
│  │                             │    │
│  ▼                             ▼    │
│ Crawler 1    Crawler 2    Crawler 3 │
│  │                             │    │
│  └──────────────┬──────────────┘    │
│                 ▼                   │
│          ┌──────────────┐           │
│          │  PostgreSQL  │           │
│          └──────────────┘           │
└─────────────────────────────────────┘

Crawler workers can be scaled using:

docker compose up --scale crawler=3
🚀 Getting Started
Prerequisites

Install:

Node.js 20+
Docker
Docker Compose
1. Clone the Repository
git clone <YOUR_REPOSITORY_URL>
cd distributed-web-crawler
2. Install Dependencies
npm install
3. Start the Test Website

The project includes a local test website containing 50 interconnected pages.

Run:

node test-server.js

The server will be available at:

http://localhost:3000

Keep this terminal running.

4. Start Redis and PostgreSQL

In another terminal:

docker compose up -d redis postgres

Verify the services:

docker compose ps
5. Build the Crawler
docker compose build crawler
6. Run a Single Crawler
docker compose up --scale crawler=1

The crawler automatically adds the configured START_URL to the Redis queue.

7. Run Multiple Crawlers

To run three crawler containers:

docker compose up --scale crawler=3

The containers share the same Redis queue and distribute URLs between themselves.

🔍 Verification

The crawler was tested against a local website containing 50 interconnected pages.

The distributed system successfully:

Crawled all 50 pages
Stored 50 pages in PostgreSQL
Stored 50 unique URLs
Used Redis as a shared work queue
Distributed URLs between multiple crawler containers
Prevented duplicate URL processing
Successfully communicated between Docker containers

Database verification:

SELECT COUNT(*), COUNT(DISTINCT url)
FROM pages;

Result:

 count | count
-------+-------
    50 |    50

This confirms:

50 total pages
50 unique URLs
0 duplicate URLs
📊 Distributed Execution

During the three-worker test, different crawler containers processed different URLs.

Example:

crawler-2 → page/45
crawler-3 → page/46
crawler-2 → page/47
crawler-3 → page/48
crawler-2 → page/49
crawler-3 → page/50

All workers consumed URLs from the same Redis queue and stored results in the same PostgreSQL database.

This demonstrates the distributed nature of the system.

📁 Project Structure
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
📌 Key Files
redis-crawler.js

Main distributed crawler implementation.

Handles:

Redis queue
URL deduplication
HTTP requests
HTML parsing
robots.txt
rate limiting
retries
PostgreSQL storage
worker management
test-server.js

Local test website used to validate crawler functionality.

docker-compose.yml

Defines the crawler, Redis, and PostgreSQL services.

Dockerfile

Builds the crawler container image.

init-db.sql

Initializes the PostgreSQL database schema.

🧪 Testing

The project was tested using:

Single Worker
docker compose up --scale crawler=1
Multiple Workers
docker compose up --scale crawler=3

Both configurations successfully crawled the complete 50-page test website.

🔮 Future Improvements

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
🎯 Learning Objectives

This project demonstrates practical concepts in:

Distributed systems
Message/work queues
Concurrent programming
Docker containerization
Redis
PostgreSQL
Web crawling
HTTP networking
HTML parsing
Rate limiting
Fault tolerance
URL deduplication
Service orchestration
