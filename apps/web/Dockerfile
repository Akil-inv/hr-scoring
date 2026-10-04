FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Vendored packages (auth-kit) that package.json installs from a file.
COPY vendor ./vendor
RUN npm ci

COPY . .
COPY next.config.js ./

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN npm run build

EXPOSE 3000

USER node
USER node
USER node
CMD ["npm", "start"]
