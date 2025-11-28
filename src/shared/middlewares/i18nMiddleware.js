export const i18nMiddleware = (req, res, next) => {
  // 1. Try Header, 2. Try Query, 3. Default to 'en'
  const rawLang = req.headers["accept-language"] || req.query.lang || "en";

  // only support 'ar' and 'en'
  const lang = rawLang.toLowerCase().startsWith("ar") ? "ar" : "en";

  req.query.lang = lang;

  next();
};
