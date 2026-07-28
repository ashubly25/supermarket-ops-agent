# Runs the Supermarket Ops Agent (Telegram long-poll). Works on x86_64 and ARM (Oracle Always Free).
FROM node:22-bookworm-slim

# Build tools for better-sqlite3's native addon (falls back to node-gyp if no prebuild).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. Native scripts must run here.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Bring the rest and build TypeScript → dist/.
COPY . .
RUN npm install --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev

ENV NODE_ENV=production \
    DB_PATH=/app/data/store.db \
    ARTIFACTS_DIR=/app/artifacts

# Persist the SQLite DB and generated artifacts.
VOLUME ["/app/data", "/app/artifacts"]

# Seed the catalogue on first boot (INSERT OR IGNORE — safe to re-run), then start.
CMD ["sh", "-c", "node dist/db/seed.js && node dist/index.js"]
