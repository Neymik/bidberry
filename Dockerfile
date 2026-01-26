FROM oven/bun:1.3.6-slim

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

RUN mkdir -p /app/exports

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
