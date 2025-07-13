const mongoose = require("mongoose");
require("dotenv").config();

const connectdb = async () => {
  const maxRetries = 3;
  let retryCount = 0;

  const connectWithRetry = async () => {
    try {
      console.log("Attempting to connect to MongoDB...");
      const conn = await mongoose.connect(
        "mongodb+srv://24intoseven:Y50uM9njFyxCWKcW@ucamuserdb.roqyoga.mongodb.net/",
        {
          serverSelectionTimeoutMS: 5000, // Timeout after 5 seconds
          socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
        }
      );
      console.log(`MongoDB Connected: ${conn.connection.host}`);
      return true;
    } catch (error) {
      retryCount++;
      console.error(
        `MongoDB connection attempt ${retryCount} failed:`,
        error.message
      );

      if (error.message.includes("IP whitelist")) {
        console.error(
          "\nPlease follow these steps to fix the IP whitelist issue:"
        );
        console.error("1. Go to MongoDB Atlas (https://cloud.mongodb.com)");
        console.error("2. Click on your cluster (UCamUserDB)");
        console.error("3. Click 'Network Access' in the left sidebar");
        console.error("4. Click 'Add IP Address'");
        console.error(
          "5. Click 'Add Current IP Address' or 'Allow Access from Anywhere'"
        );
        console.error("6. Click 'Confirm'\n");
      }

      if (retryCount < maxRetries) {
        console.log(
          `Retrying connection in 5 seconds... (Attempt ${
            retryCount + 1
          } of ${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return connectWithRetry();
      } else {
        console.error("Max retries reached. Could not connect to MongoDB.");
        process.exit(1);
      }
    }
  };

  return connectWithRetry();
};

module.exports = connectdb;
