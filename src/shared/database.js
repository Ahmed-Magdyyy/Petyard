import mongoose from "mongoose";

export const dbConnection = () => {
  
  // Connect to MongoDB and start server
  mongoose
    .connect(process.env.MONGO_URI)
    .then((conn) => {
      console.log(`Server connected to DB: ${conn.connection.host}`);
    })
    .catch((err) => {
      console.error("Failed to connect to MongoDB", err);
    });
};

