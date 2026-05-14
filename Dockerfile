# Stage 1: install production dependencies
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: minimal runtime
FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY server.js .
COPY public/ ./public/
USER appuser
EXPOSE 45123
ENV PORT=45123
CMD ["node", "server.js"]
