import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { config } from "./config.js";
import { httpsRedirect } from "./middleware/httpsRedirect.js";
import { accessAuth } from "./middleware/accessAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { setupWsProxy } from "./services/wsProxy.js";
import { prewarmSAPSigner } from "./services/sapSigner.js";
import authRoutes from "./routes/auth.js";
import searchRoutes from "./routes/search.js";
import downloadRoutes from "./routes/downloads.js";
import packageRoutes from "./routes/packages.js";
import installRoutes from "./routes/install.js";
import settingsRoutes from "./routes/settings.js";
import bagRoutes from "./routes/bag.js";
import sapRoutes from "./routes/sap.js";
import versionMetadataRoutes from './routes/versionMetadata.js';
import releaseHistoryRoutes from './routes/releaseHistory.js';

const app = express();

// Middleware
app.use(httpsRedirect);
app.use(express.json({ limit: "50mb" }));

// API routes
app.use("/api", accessAuth);
app.use("/api", authRoutes);
app.use("/api", searchRoutes);
app.use("/api", downloadRoutes);
app.use("/api", packageRoutes);
app.use("/api", installRoutes);
app.use("/api", settingsRoutes);
app.use("/api", bagRoutes);
app.use("/api", sapRoutes);
app.use('/api', versionMetadataRoutes);
app.use('/api', releaseHistoryRoutes);

// Serve static frontend files
const publicDir = path.resolve(import.meta.dirname, "../public");
app.use(
  express.static(publicDir, {
    setHeaders: (res, filePath) => {
      const relativePath = path.relative(publicDir, filePath);
      if (relativePath.startsWith(`assets${path.sep}`)) {
        res.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      } else if (path.basename(filePath) === "index.html") {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

// SPA fallback: serve index.html for non-API routes
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }
  const indexPath = path.join(publicDir, "index.html");
  if (fs.existsSync(indexPath)) {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// Error handler (must be last)
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

// WebSocket proxy for Apple TCP connections
setupWsProxy(server);

// Ensure data directory exists
fs.mkdirSync(config.dataDir, { recursive: true });

server.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
  console.log(`Data directory: ${path.resolve(config.dataDir)}`);
  void prewarmSAPSigner().catch((error) => {
    console.error(
      "SAP signer prewarm failed:",
      error instanceof Error ? error.message : error,
    );
  });
});

export { app, server };
