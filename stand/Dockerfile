FROM oven/bun:1.3.14

WORKDIR /app

COPY daemon/package.json daemon/bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY daemon/ ./

ENV TELEGRAM_DAEMON_PORT=4822
EXPOSE 4822

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:4822/health'); if (!response.ok) process.exit(1)"]

CMD ["bun", "run", "server.ts"]
