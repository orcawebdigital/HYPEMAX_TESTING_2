const config = require("../config");
const { bad, HttpError } = require("../util");

let cld = null;
function client() {
  if (!cld && !config.features.cloudinary) throw new HttpError(503, "Image uploads are not configured yet. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the server environment.", "CLOUDINARY_MISSING");
  if (!cld) {
    cld = require("cloudinary").v2; // picks up CLOUDINARY_URL from the environment if present
    const c = config.cloudinary;
    if (c.cloudName && c.apiKey && c.apiSecret) cld.config({ cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret });
    cld.config({ secure: true });
  }
  return cld;
}

/** Credential check for the admin "Integrations" screen. Returns the cloud name only, never keys. */
async function ping() {
  const r = await client().api.ping();
  return { ok: r && r.status === "ok", cloud_name: client().config().cloud_name };
}

const MAX_BYTES = 8 * 1024 * 1024;
/** Detect real image type from magic bytes; never trust the browser's mimetype alone. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 4, 12).match(/^ftyp(avif|avis)/)) return "avif";
  return null;
}
function validateImage(file) {
  if (!file) throw bad("Choose an image to upload");
  if (file.size > MAX_BYTES) throw bad("Image must be 8 MB or smaller");
  const t = sniff(file.buffer);
  if (!t) throw bad("Only PNG, JPG, WEBP or AVIF images are allowed");
  return t;
}

/** Upload a validated buffer. Returns { public_id, url, width, height }. */
function uploadBuffer(buffer, subfolder = "misc") {
  const c = client();
  return new Promise((resolve, reject) => {
    c.uploader.upload_stream(
      { folder: `${config.cloudinaryFolder}/${subfolder}`, resource_type: "image", overwrite: false, unique_filename: true },
      (err, r) => (err ? reject(new HttpError(502, "Cloudinary upload failed: " + err.message)) : resolve({ public_id: r.public_id, url: r.secure_url, width: r.width, height: r.height }))
    ).end(buffer);
  });
}
function uploadPath(filePath, subfolder = "misc") {
  return client().uploader.upload(filePath, { folder: `${config.cloudinaryFolder}/${subfolder}`, resource_type: "image" })
    .then((r) => ({ public_id: r.public_id, url: r.secure_url, width: r.width, height: r.height }));
}

/** Delete by public_id. Never throws (a failed cleanup must not break the request); returns boolean. */
async function destroy(publicId) {
  if (!publicId || (!cld && !config.features.cloudinary)) return false;
  try {
    const r = await client().uploader.destroy(publicId, { resource_type: "image", invalidate: true });
    return r.result === "ok" || r.result === "not found";
  } catch (e) {
    console.error("Cloudinary delete failed", publicId, e.message);
    return false;
  }
}

module.exports = { validateImage, uploadBuffer, uploadPath, destroy, ping, MAX_BYTES, _setTestClient: (c) => { cld = c; } };
