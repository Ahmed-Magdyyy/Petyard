import express from "express";
import path from "path";
import { config } from "dotenv";
import { fileURLToPath } from 'url'
const app = express();
const PORT = process.env.PORT || 3000;
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import {ApiError} from "../shared/ApiError.js";
import {globalError} from "../shared/middlewares/errorMiddleware.js";
import {dbConnection} from "../shared/database.js";
import { mountRoutes } from "./routes.js";

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
config({ path: path.resolve(__dirname, '../shared/.env') });

// middlewares
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "uploads")));
app.use(cookieParser());

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

app.get('/', (req, res) => {
  res.send('Swift move API is running.');
});

app.all("*", (req, res, next) => {
  next(new ApiError(`can't find this route: ${req.originalUrl}`, 400));
});

// Global error handling middleware
app.use(globalError);

const server = app.listen(PORT , () =>
  console.log(`Example app listening on port ${PORT}!`)
);

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