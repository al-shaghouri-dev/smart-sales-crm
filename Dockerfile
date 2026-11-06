# Smart Sales CRM — production image (API + built React frontend + Socket.IO + background jobs).
# One image serves every process role: PROCESS_ROLE=all (default) | web | worker.
#   docker build -t smart-sales-crm .
# Runtime data (uploads, message media) lives in the /data volume.

# ---------- build stage: install all deps, build the frontend, drop dev deps ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime stage ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    PROCESS_ROLE=all \
    UPLOADS_DIR=/data/uploads \
    MEDIA_DRIVER=local \
    MEDIA_DIR=/data/media
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json knexfile.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node db ./db
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /data/uploads /data/media && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
# Liveness only (the process answers). Orchestrators should use /api/ready for readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
