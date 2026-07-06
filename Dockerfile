# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG NODE_AUTH_TOKEN

# Set working directory
WORKDIR /app

# Copy package files and .npmrc for GitHub Packages auth
COPY package*.json .npmrc ./

# Install dependencies (--ignore-scripts prevents 'prepare' from running before source is copied)
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Prune dev dependencies in builder stage (while .npmrc auth is still available)
RUN npm prune --omit=dev

# Remove .npmrc so auth token is not leaked into production image
RUN rm -f .npmrc

# Production stage
FROM node:26-alpine AS production

# Pull latest Alpine package fixes (e.g. OpenSSL) even when the base layer is cached
RUN apk -U upgrade --no-cache

# Create a non-root user for security
RUN addgroup -g 1001 -S kaseya-quote-manager && \
    adduser -S kaseya-quote-manager -u 1001 -G kaseya-quote-manager

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Remove the bundled npm CLI from the production image; the runtime only needs
# node, and npm's bundled dependencies trigger Trivy base-image CVE alerts.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Create logs directory
RUN mkdir -p /app/logs && chown -R kaseya-quote-manager:kaseya-quote-manager /app

# Switch to non-root user
USER kaseya-quote-manager

# Expose port
EXPOSE 8080

# Health check against the actual HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

# Define volume for logs
VOLUME ["/app/logs"]

# Start the application
CMD ["node", "dist/http.js"]

# Build arguments for runtime
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# Labels for metadata
LABEL io.modelcontextprotocol.server.name="io.github.wyre-technology/kaseya-quote-manager-mcp"
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="Kaseya Quote Manager MCP Server - Read-only MCP server for Kaseya Quote Manager (Datto Commerce)"
LABEL org.opencontainers.image.title="kaseya-quote-manager-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Kaseya Quote Manager (Datto Commerce) integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/wyre-technology/kaseya-quote-manager-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/wyre-technology/kaseya-quote-manager-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/wyre-technology/kaseya-quote-manager-mcp/pkgs/container/kaseya-quote-manager-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
