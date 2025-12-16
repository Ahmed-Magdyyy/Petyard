import express from "express";
import path from "path";
import { config } from "dotenv";
import { fileURLToPath } from 'url'
const app = express();
const PORT = process.env.PORT || 3000;
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import https from "https";
import {ApiError} from "../shared/ApiError.js";
import {globalError} from "../shared/middlewares/errorMiddleware.js";
import {dbConnection} from "../shared/database.js";
import { mountRoutes } from "./routes.js";
import { i18nMiddleware } from "../shared/middlewares/i18nMiddleware.js";
import { startAbandonedCartsJob } from "../shared/jobs/abandonedCarts.job.js";
import { getRedisClient } from "../shared/redisClient.js";
import { getFirebaseAdmin } from "../shared/firebaseAdmin.js";

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
config({ path: path.resolve(__dirname, '../shared/.env') });

// middlewares
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "uploads")));
app.use(cookieParser());
app.use(i18nMiddleware);

if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
  console.log(`mode: ${process.env.NODE_ENV}`);
}

//helmet
app.use(helmet())
// DB connecetion
dbConnection();

// Mount Routes
mountRoutes(app)

// Background jobs
startAbandonedCartsJob();

app.get('/', (req, res) => {
  res.send('Petyard API is running.');
});

app.all("*", (req, res, next) => {
  next(new ApiError(`can't find this route: ${req.originalUrl}`, 400));
});

// Global error handling middleware
app.use(globalError);

const server = app.listen(PORT , () =>
  console.log(`Example app listening on port ${PORT}!`)
)

getRedisClient()
getFirebaseAdmin()

// Ping the server immediately after starting the server
pingServer();

// Ping the server every 14 minutes (14 * 60 * 1000 milliseconds)
const pingInterval = 15 * 60 * 1000;
setInterval(pingServer, pingInterval);

// Function to ping the server by hitting the specified API route
function pingServer() {
  const pingEndpoint = 'https://petyard.onrender.com/api/v1/banners';

  // Send a GET request to the ping endpoint
  https.get(pingEndpoint, (res) => {
    console.log(`Ping sent to server: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error('Error while sending ping:', err);
  });
}

// UnhandledRejections event handler (rejection outside express)
process.on("unhandledRejection", (err) => {
  console.error(
    `unhandledRejection Errors: ${err.name} | ${err.message} | ${err.stack}`
  );
  server.close(() => {
    console.log("server shutting down...");
    process.exit(1);
  });
});