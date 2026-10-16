FROM node:20-alpine AS builder
WORKDIR /app

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Только скомпилированные артефакты + package.json для preview
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

RUN npm install --omit=dev && npm install serve@14 -g

EXPOSE 4173
CMD ["serve", "-s", "dist", "-l", "4173"]
