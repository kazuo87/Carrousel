FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data/images && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1
CMD ["node", "src/index.js"]
