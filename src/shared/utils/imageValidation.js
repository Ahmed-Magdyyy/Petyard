import sharp from "sharp";
import { SaxesParser } from "saxes";
import { ApiError } from "./ApiError.js";

const MIME_FORMATS = { "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png",
  "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

function invalid(message) {
  throw new ApiError(message, 400, [{ path: "images", msg: message, code: "IMAGE_FILE_INVALID" }]);
}

function validateSvg(buffer) {
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { invalid("SVG must use valid UTF-8 encoding."); }
  const parser = new SaxesParser({ xmlns: true });
  let root = false, depth = 0, nodes = 0;
  parser.on("error", () => invalid("Malformed SVG image."));
  parser.on("doctype", () => invalid("SVG document types and external entities are not allowed."));
  parser.on("processinginstruction", () => invalid("SVG processing instructions are not allowed."));
  parser.on("opentag", (tag) => {
    if (++depth > 64 || ++nodes > 20000) invalid("SVG is too complex.");
    if (!root) { if (tag.local !== "svg") invalid("Expected an SVG root."); root = true; }
    if (!["", "http://www.w3.org/2000/svg"].includes(tag.uri) ||
      ["script", "foreignobject", "style", "set"].includes(tag.local.toLowerCase()) || tag.local.toLowerCase().startsWith("animate")) {
      invalid("SVG active content and foreign markup are not allowed.");
    }
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.prefix === "xmlns" || attribute.name === "xmlns") continue;
      const name = attribute.local.toLowerCase(), value = attribute.value;
      if (name.startsWith("on") || ["style", "src", "base"].includes(name)) invalid("SVG event handlers, base overrides and inline styles are not allowed.");
      if (name === "href" && !/^#[a-zA-Z_][\w:.-]*$/.test(value)) invalid("SVG references must stay within the image.");
      if (/url\s*\(/i.test(value) && !/^url\(\s*["']?#[a-zA-Z_][\w:.-]*["']?\s*\)$/i.test(value)) {
        invalid("SVG resources must stay within the image.");
      }
    }
  });
  parser.on("closetag", () => { depth--; });
  try { parser.write(source).close(); }
  catch (error) { if (error instanceof ApiError) throw error; invalid("Malformed SVG image."); }
  if (!root) invalid("Expected an SVG image.");
}

export async function inspectImageBytes(file) {
  if (!Buffer.isBuffer(file.buffer) || !file.buffer.length) invalid("Supply a nonempty image file.");
  if (file.mimetype === "image/svg+xml") validateSvg(file.buffer);
  let metadata;
  try { metadata = await sharp(file.buffer, { limitInputPixels: 25000000 }).metadata(); }
  catch { invalid("Image bytes are invalid or exceed the decoded pixel limit."); }
  if (metadata.format !== MIME_FORMATS[file.mimetype]) invalid("Image bytes do not match the declared MIME type.");
  const pixels = metadata.width * (metadata.pageHeight ?? metadata.height) * (metadata.pages ?? 1);
  if (!metadata.width || !metadata.height || metadata.width > 8000 || metadata.height > 8000 || pixels > 25000000) {
    invalid("Image dimensions must not exceed 8000 per side or 25 million decoded pixels.");
  }
  if (metadata.format === "gif") {
    try { await sharp(file.buffer, { animated: true, limitInputPixels: 25000000 }).stats(); }
    catch { invalid("GIF frames could not be decoded."); }
  }
  return metadata;
}
