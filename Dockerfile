FROM node:20-bookworm-slim AS base

# sharp needs these for the libvips build it downloads; tesseract.js needs
# nothing extra at build time (it fetches trained data lazily at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

RUN mkdir -p storage/uploads

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
