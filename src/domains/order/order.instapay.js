export const MAX_INSTAPAY_SCREENSHOTS = 5;

export function getInstapayScreenshotFiles(req) {
  const legacyFiles = Array.isArray(req?.files?.instapayScreenshot)
    ? req.files.instapayScreenshot
    : req?.file
      ? [req.file]
      : [];
  const multipleFiles = Array.isArray(req?.files?.instapayScreenshots)
    ? req.files.instapayScreenshots
    : [];

  return [...legacyFiles, ...multipleFiles];
}
