# 零依赖运行时镜像：同时承载长驻复核服务与一次性 verify 验收。
FROM node:20-alpine

WORKDIR /app

# 全部为本地源码，无需 npm install。
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY web-src ./web-src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# 预构建静态复核页到 public/（verify 会再次构建校验）。
RUN node scripts/build.js

# verify 服务会覆盖该 command（见 docker-compose.yml）。
CMD ["node", "src/server.js"]
