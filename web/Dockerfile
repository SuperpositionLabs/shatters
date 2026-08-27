# Build stage: compile the client to Next's standalone output, which bundles
# only the server files and dependencies actually reached.
FROM node:22-alpine AS build
WORKDIR /src

# scripts/ comes with the manifests because postinstall runs during `npm ci`
# and patches the libsodium ESM build. Copying it here rather than with the
# rest of the source keeps the dependency layer cacheable.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Bind to every interface: the container's own address is not known in advance
# and only the reverse proxy can reach it.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Runs as the image's built-in unprivileged user, matching the distroless
# nonroot the API image uses. A public-facing process has no reason to be root.
USER node

COPY --from=build --chown=node:node /src/.next/standalone ./
COPY --from=build --chown=node:node /src/.next/static ./.next/static
COPY --from=build --chown=node:node /src/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
