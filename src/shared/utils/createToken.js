import jwt from "jsonwebtoken";

// Access Token (short-lived 3H)
export const createAccessToken = (userId, role) => {
  return jwt.sign({ userId, role }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "3h",
  });
};

// Refresh Token (long-lived 30D)
export const createRefreshToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: "30d",
  });
};


