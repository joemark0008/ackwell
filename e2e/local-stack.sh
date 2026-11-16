#!/bin/sh
# Throwaway local stack for the Playwright flow: Postgres 16 + the API (:3000) + Vite (:5173) in
# node:22-alpine on the host network, seeded with a known admin. Usage: ./local-stack.sh up|down|test
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG=ackwell-e2e-pg; APP=ackwell-e2e-app
PGPW=${PGPW:-e2e-postgres}
export QA_EMAIL=${QA_EMAIL:-admin@ackwell.test}
export QA_PASSWORD=${QA_PASSWORD:-correct-horse-battery}
case "${1:-}" in
  up)
    docker run -d --rm --name $PG -p 127.0.0.1:5499:5432 -e POSTGRES_PASSWORD=$PGPW postgres:16-alpine >/dev/null
    docker run -d --rm --name $APP --network host -v "$ROOT":/app -w /app \
      -e NODE_ENV=development -e PORT=3000 -e APP_URL=http://localhost:5173 \
      -e DATABASE_URL=postgres://postgres:$PGPW@127.0.0.1:5499/postgres \
      -e BETTER_AUTH_SECRET=e2e-better-auth-secret-0123456789abcdef \
      -e SEED_ADMIN_EMAIL=$QA_EMAIL -e SEED_ADMIN_PASSWORD=$QA_PASSWORD \
      -e MLLP_PORT_RANGE=6060-6070 -e MLLP_BIND_ADDRESS=127.0.0.1 -e MLLP_ADVERTISED_HOST=127.0.0.1 \
      -e DELIVERY_RETRY_DELAY_SECONDS=1 -e QUEUE_POLL_SECONDS=0.5 -e LOG_LEVEL=info \
      -e TURBO_TELEMETRY_DISABLED=1 -e NPM_CONFIG_UPDATE_NOTIFIER=false \
      node:22-alpine sh -c "npm run build -w @ackwell/schemas && npx turbo run dev --filter=@ackwell/api --filter=@ackwell/web" >/dev/null
    echo "waiting for the API and Vite..."
    for i in $(seq 1 120); do
      if curl -sf http://localhost:5173/health >/dev/null 2>&1; then echo "up: http://localhost:5173"; exit 0; fi
      sleep 2
    done
    echo "stack did not come up"; docker logs $APP | tail -40; exit 1 ;;
  down)
    docker rm -f $APP $PG >/dev/null 2>&1 || true; echo "down" ;;
  test)
    docker run --rm --network host -v "$ROOT/e2e":/e2e -w /e2e \
      -e BASE_URL=${BASE_URL:-http://localhost:5173} -e QA_EMAIL -e QA_PASSWORD ${MLLP_PORT:+-e MLLP_PORT=$MLLP_PORT} ${WEBHOOK_URL:+-e WEBHOOK_URL=$WEBHOOK_URL} \
      mcr.microsoft.com/playwright:v1.65.1-noble sh -c "npm install --no-audit --no-fund >/dev/null && npx playwright test" ;;
  *) echo "usage: $0 up|down|test"; exit 2 ;;
esac
