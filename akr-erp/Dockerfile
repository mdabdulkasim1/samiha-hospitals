# =============================================================================
# AKR General Trading ERP
#
# A Dockerfile rather than an inferred build, because the one dependency that
# matters is native: better-sqlite3 is compiled from C++ when no prebuilt
# binary is published for the platform's exact Node version, and a builder that
# guesses the Node version or ships without a toolchain fails at that step.
# Here both are pinned, so the build that runs on the platform is the build
# that was tested.
# =============================================================================
FROM node:20-bookworm-slim AS build

# What better-sqlite3 needs if it has to compile itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# The compiled module comes across from the build stage; the toolchain does not.
COPY --from=build /app/node_modules ./node_modules
COPY . .

# The mount point for the volume that holds the database. It is left empty, and
# DATA_DIR is deliberately unset: if no volume is mounted the application has to
# be able to tell, and say so, rather than quietly writing the books somewhere
# that is erased on the next deploy.
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "src/server.js"]
