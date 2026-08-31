# Stage 1: Build Apple SAP signer
FROM golang:1.25.11-bookworm AS sap-signer-build
WORKDIR /src
COPY sap-signer/go.mod sap-signer/go.sum ./
RUN go mod download
COPY sap-signer/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/asspp-sap-signer ./cmd/asspp-sap-signer

# Stage 2: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 3: Build backend
FROM node:20-alpine AS backend-build
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 4: Runtime
FROM node:20-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/package.json ./
COPY --from=frontend-build /app/frontend/dist ./public
COPY --from=sap-signer-build /out/asspp-sap-signer /usr/local/bin/asspp-sap-signer
RUN mkdir -p /data/packages /data/.cache
EXPOSE 8080
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE \
    SAP_SIGNER_BINARY=/usr/local/bin/asspp-sap-signer XDG_CACHE_HOME=/data/.cache
CMD ["node", "dist/index.js"]
