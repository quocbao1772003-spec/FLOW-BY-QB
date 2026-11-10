# Flowboard team server: one container = web UI + API + media + extension
# bridge (/ws/bridge). Google Flow itself still runs in each staff member's
# Chrome through the Flowboard Bridge extension.

FROM node:20-bookworm-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
# `vite build` only (the repo still has TypeScript warnings that `tsc -b` would stop on).
RUN npx vite build

FROM python:3.12-slim
# Claude Code CLI powers Auto-Prompt / Vision / Planner (same as on the PC).
# Log it in with CLAUDE_CODE_OAUTH_TOKEN in .env (see docs/SERVER.md).
# Build with --build-arg WITH_CLAUDE_CLI=0 to leave it out.
ARG WITH_CLAUDE_CLI=1
COPY --from=ui /usr/local/bin/node /usr/local/bin/node
COPY --from=ui /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && if [ "$WITH_CLAUDE_CLI" = "1" ]; then npm install -g --no-audit --no-fund @anthropic-ai/claude-code && npm cache clean --force; fi
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/agent \
    FLOWBOARD_STORAGE=/data \
    FLOWBOARD_FRONTEND_DIST=/app/frontend/dist \
    IS_SANDBOX=1
WORKDIR /app
COPY agent/requirements.txt agent/requirements.txt
RUN pip install --no-cache-dir -r agent/requirements.txt
COPY agent/flowboard agent/flowboard
COPY agent/flowboard_mcp agent/flowboard_mcp
COPY extension extension
COPY --from=ui /src/frontend/dist frontend/dist
VOLUME ["/data"]
EXPOSE 8101
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8101/api/health',timeout=4).status==200 else 1)"
CMD ["python", "-m", "uvicorn", "flowboard.main:app", "--host", "0.0.0.0", "--port", "8101", \
     "--proxy-headers", "--forwarded-allow-ips", "*", "--ws-max-size", "67108864"]
