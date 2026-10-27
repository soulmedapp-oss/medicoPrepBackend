FROM node:22-bookworm-slim
LABEL io.soulmed.production-release="1" io.soulmed.finite-dispatcher="1"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
