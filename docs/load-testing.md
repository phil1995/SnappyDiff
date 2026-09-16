# Load testing

Use the bounded smoke driver only against an environment you own and may test. It defaults to the read-only `/health` endpoint and never creates data.

```bash
SNAPPYDIFF_LOAD_ORIGIN=https://staging.example.com \
SNAPPYDIFF_LOAD_SECONDS=60 \
SNAPPYDIFF_LOAD_CONCURRENCY=25 \
npm run load:smoke
```

The command emits request count, failure rate, throughput, and p50/p95/p99 latency as JSON and fails above a one-percent error rate. Start at concurrency 5, then 25, 50, and 100 while watching Worker CPU, D1 contention, R2 operations, rate-limit responses, and job backlog.

Upload-burst tests must use synthetic PNGs and disposable projects. Cover duplicate and unique hashes, matrix shards, interrupted uploads, and concurrent finalization. Confirm reservations return to zero, byte accounting matches active images, jobs drain, and abandoned staged publications are collected. Record results and adopted limits in the environment runbook.
