FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ── Install dependencies ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ── Build ──
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── Production image ──
FROM base AS runner
ENV NODE_ENV=production
# Audio moderation transcodes with the ffmpeg CLI (helper/audioAnalyzer.ts,
# /usr/bin/ffmpeg); alpine does not ship it.
RUN apk add --no-cache ffmpeg
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

EXPOSE 5000
CMD ["node", "dist/server.js"]
