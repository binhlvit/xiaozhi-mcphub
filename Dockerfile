# syntax=docker/dockerfile:1.7

FROM python:3.13-slim-trixie AS base

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# 添加 HTTP_PROXY 和 HTTPS_PROXY 环境变量
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY

# git is kept in the runtime image (not just the builder) because some MCP servers
# are installed on demand via `npx github:owner/repo` / `uvx --from git+...`.
RUN apt-get update && apt-get install -y curl gnupg git \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

ENV RUSTUP_HOME=/usr/local/rustup \
  CARGO_HOME=/usr/local/cargo \
  PATH=/usr/local/cargo/bin:$PATH

ARG REQUEST_TIMEOUT=60000
ENV REQUEST_TIMEOUT=$REQUEST_TIMEOUT

ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH

RUN uv tool install mcp-server-fetch

WORKDIR /app

# ---------------------------------------------------------------------------
# builder: compiler toolchain + full (dev+prod) dependencies, used only to
# produce dist/, frontend/dist/ and a pruned node_modules. Discarded after —
# none of it (gcc, source tree, devDependencies) reaches the runtime image.
# ---------------------------------------------------------------------------
FROM base AS builder

RUN apt-get update && apt-get install -y build-essential \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && pnpm fetch --frozen-lockfile
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --offline

COPY . .

# Download the latest servers.json from mcpm.sh and replace the existing file
RUN curl -s -f --connect-timeout 10 https://mcpm.sh/api/servers.json -o servers.json || echo "Failed to download servers.json, using bundled version"

RUN pnpm build

# Drop devDependencies (typescript, vite, jest, eslint, ...) now that dist/ and
# frontend/dist/ exist — the running app only needs the "dependencies" graph.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# runtime: base + only the build output. No compiler, no devDependencies, no
# raw source/tests/docs — CI passes INSTALL_EXT=true for published images, so
# that block has to stay here (it installs runtime tools, not build tools;
# entrypoint.sh starts dockerd from it on container boot).
# ---------------------------------------------------------------------------
FROM base AS runtime

ARG INSTALL_EXT=false
RUN if [ "$INSTALL_EXT" = "true" ]; then \
  ARCH=$(uname -m); \
  if [ "$ARCH" = "x86_64" ]; then \
  npx -y playwright install --with-deps chrome firefox; \
  else \
  echo "Skipping Chrome and Firefox installation on non-amd64 architecture: $ARCH"; \
  fi; \
  # Install Rust toolchain and Docker Engine (includes CLI and daemon) \
  apt-get update && \
  apt-get install -y ca-certificates curl iptables && \
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal && \
  cargo --version && rustc --version && \
  install -m 0755 -d /etc/apt/keyrings && \
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
  chmod a+r /etc/apt/keyrings/docker.asc && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
  apt-get update && \
  apt-get install -y docker-ce docker-ce-cli containerd.io && \
  apt-get clean && rm -rf /var/lib/apt/lists/*; \
  fi

# Rarely-changing layers first (deps), frequently-changing build output last —
# keeps the cache warm across rebuilds that only touch application code.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/locales ./locales
COPY --from=builder /app/mcp_settings.json /app/servers.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/frontend/dist ./frontend/dist

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pnpm", "start"]
