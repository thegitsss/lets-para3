FROM node:24.18.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    MONGOMS_DISABLE_POSTINSTALL=true \
    LPC_USE_BUILT_FRONTEND=true
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN node -e "if (process.versions.node !== '24.18.0') process.exit(1)" && npm ci --include=dev
WORKDIR /app
COPY --chown=node:node . .
RUN cd backend && node scripts/verify-runtime.js && npm run build:frontend
USER node
WORKDIR /app/backend
CMD ["node", "scripts/start-staging.js"]
