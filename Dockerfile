FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ca-certificates wget gnupg libgtk-3-0 libx11-6 libxkbcommon0 libasound2 libnss3 libxss1 libgbm1 libatk1.0-0 libc6 \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci --unsafe-perm

RUN npx playwright install --with-deps chromium

COPY . .

ENV PORT=8080
ENV CACHE_TTL=60
EXPOSE 8080
CMD ["node","server.js"]
