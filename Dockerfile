# free-llm-router 针对 VPS 与生产容器化的高性能极简镜像
# 产物已由 esbuild 预编译为单文件 dist/server.mjs，无需冗余 node_modules

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=11451 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/router.db

# 创建持久化数据目录
RUN mkdir -p /app/data && chown -R node:node /app

COPY --chown=node:node dist/server.mjs ./dist/server.mjs

USER node

EXPOSE 11451

VOLUME ["/app/data"]

CMD ["node", "dist/server.mjs"]
