# Isolated development contour

This is a deliberately tiny, dependency-free Docker smoke target. It does not
contain product code, worker code, credentials, or deployment automation.

## Run locally

```sh
docker compose up -d --build
./test_smoke.sh
./smoke.sh
docker compose ps
docker compose down
```

The service binds only to `127.0.0.1:18080` and exposes `GET /health`. Compose
restarts it if the process exits; Docker's healthcheck is independent evidence
that the endpoint is responding. No `.env` file or secret is read.
