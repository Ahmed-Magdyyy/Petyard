import "@dotenvx/dotenvx/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
const app = express();
app.set("trust proxy", 1); // Trust first proxy so rate limiters use real client IPs
const PORT = process.env.PORT || 3000;
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import https from "https";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";

import { globalError } from "../shared/middlewares/errorMiddleware.js";
import { unmatchedRouteHandler } from "../shared/middlewares/botFilterMiddleware.js";
import { globalApiLimiter } from "../shared/middlewares/rateLimitMiddleware.js";
import { dbConnection } from "../config/database.js";
import { mountRoutes } from "./routes.js";
import { i18nMiddleware } from "../shared/middlewares/i18nMiddleware.js";
import { startAbandonedCartsJob } from "../shared/jobs/abandonedCarts.job.js";
import { startNotificationJobs } from "../shared/jobs/notification.jobs.js";
import { startAbandonedPaymentsJob } from "../shared/jobs/abandonedPayments.job.js";
import { startAppDownloadsJob } from "../shared/jobs/appDownloads.job.js";
import { getRedisClient } from "../config/redis.js";
import { getFirebaseAdmin } from "../config/firebase.js";
import cors from "cors";
import { egyptTimezoneReplacer } from "../shared/utils/egyptTimezone.js";
import { validateMediaConfiguration } from "../shared/utils/mediaConfig.js";

validateMediaConfiguration();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// middlewares
app.set("json replacer", egyptTimezoneReplacer);
app.use(express.urlencoded({ extended: false, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "uploads")));
app.use(cookieParser());
app.use(compression());
app.use(i18nMiddleware);

// Keep the request and any error raised while handling it tied together in
// production logs, even when both events happen in the same second.
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

// Security middleware
app.use(mongoSanitize());
app.use(hpp());
app.use(
  cors({
    origin: [
      "https://petyard.netlify.app",
      ...(process.env.NODE_ENV === "development"
        ? ["http://localhost:3002", "http://localhost:3001"]
        : []),
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept-Language",
      "x-guest-id",
      "Idempotency-Key",
    ],
    credentials: true,
  }),
);

app.use(
  morgan((tokens, req, res) => {
    const status = Number(tokens.status(req, res));
    const loggedAt = new Date().toISOString();
    const statusColor =
      status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;

    return `\x1b[0m${tokens.method(req, res)} ${tokens.url(req, res)} ` +
      `\x1b[${statusColor}m${status}\x1b[0m ` +
      `${tokens["response-time"](req, res)} ms - ` +
      `${tokens.res(req, res, "content-length") || "-"} ` +
      `requestId=${req.requestId} loggedAt=${loggedAt}\x1b[0m`;
  }),
);

//helmet
app.use(helmet());
// DB connecetion
dbConnection();

// Global API rate limiter (applied before all routes)
app.use("/api/", globalApiLimiter);

// Mount Routes
mountRoutes(app);

// Background jobs
startAbandonedCartsJob();
startNotificationJobs();
startAbandonedPaymentsJob();
startAppDownloadsJob();

app.get("/", (req, res) => {
  res.send("Petyard API is running.");
});

app.all("*", unmatchedRouteHandler);

// Global error handling middleware
app.use(globalError);

const server = app.listen(PORT, () =>
  console.log(`Example app listening on port ${PORT}!`),
);

getRedisClient();
getFirebaseAdmin();

// // Ping the server immediately after starting the server
// pingServer();

// // Ping the server every 14 minutes (14 * 60 * 1000 milliseconds)
// const pingInterval = 14 * 60 * 1000;
// if (!globalThis.__petyardPingIntervalId) {
//   globalThis.__petyardPingIntervalId = setInterval(pingServer, pingInterval);
// }

// // Function to ping the server by hitting the specified API route
// function pingServer() {
//   const pingEndpoint =
//     "https://petyard.onrender.com/api/v1/locations/options?__internal_ping=1";

//   // Send a GET request to the ping endpoint
//   const req = https
//     .request(
//       pingEndpoint,
//       {
//         method: "GET",
//         headers: {
//           "User-Agent": "petyard-internal-ping",
//           "X-Internal-Ping": "1",
//         },
//       },
//       (res) => {
//         console.log(`Ping sent to server: ${res.statusCode}`);
//         res.resume();
//       },
//     )
//     .on("error", (err) => {
//       console.error("Error while sending ping:", err);
//     });

//   req.end();
// }

// UnhandledRejections event handler (rejection outside express)
process.on("unhandledRejection", (err) => {
  console.error(
    `unhandledRejection Errors: ${err.name} | ${err.message} | ${err.stack}`,
  );
  server.close(() => {
    console.log("server shutting down...");
    process.exit(1);
  });
});
