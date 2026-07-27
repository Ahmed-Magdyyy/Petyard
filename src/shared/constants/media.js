const LEGACY_DEFAULT_USER_AVATAR_URL =
  "https://res.cloudinary.com/dx5n4ekk2/image/upload/v1767069108/petyard/users/user_default_avatar_2.svg";

export const DEFAULT_USER_AVATAR_URL =
  typeof process.env.DEFAULT_USER_AVATAR_URL === "string" &&
  process.env.DEFAULT_USER_AVATAR_URL.trim()
    ? process.env.DEFAULT_USER_AVATAR_URL.trim()
    : LEGACY_DEFAULT_USER_AVATAR_URL;
