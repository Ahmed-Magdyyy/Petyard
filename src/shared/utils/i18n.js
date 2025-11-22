export function pickLocalizedField(doc, base, lang, fallbackLang = "en") {
  const key = `${base}_${lang}`;
  const fallbackKey = `${base}_${fallbackLang}`;
  return doc[key] || doc[fallbackKey] || "";
}
