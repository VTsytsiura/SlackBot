FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Don't run as root; the node image ships an unprivileged "node" user.
USER node

# --enable-source-maps: stack traces in CloudWatch point at src/*.ts lines.
CMD ["node", "--enable-source-maps", "dist/app.js"]
