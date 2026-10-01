// Vercel Serverless Function: proxy /api/v1/* to the upstream API.
//
// Body parsing is disabled so file uploads (multipart/form-data) stream
// through byte-for-byte. We forward the raw request body untouched for
// every method that can carry one, preserving the original content-type
// (including the multipart boundary). JSON requests pass through
// identically to before.
export const config = {
  api: { bodyParser: false }
};

// Hard cap on proxied request bodies. The API's largest legitimate upload is
// the 10MB VIN photo, so anything past this is abuse: the proxy buffers
// bodies in memory before forwarding, and an unbounded read is a
// memory-exhaustion vector for the function.
const MAX_PROXY_BODY_BYTES = 12 * 1024 * 1024;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > MAX_PROXY_BODY_BYTES) {
        rejected = true;
        reject(
          Object.assign(new Error("Request body too large"), {
            code: "PROXY_BODY_TOO_LARGE"
          })
        );
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  const upstream = process.env.UPSTREAM_API_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (!upstream) {
    return res.status(500).json({
      error: {
        code: "PROXY_CONFIGURATION_ERROR",
        message: "The API proxy is not configured."
      }
    });
  }

  const pathValue = req.query?.path;
  const path = Array.isArray(pathValue) ? pathValue.join("/") : String(pathValue || "");
  const url = `${upstream.replace(/\/$/, "")}/api/v1/${path}`;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();
    if (["host", "content-length", "connection", "cookie"].includes(lower)) continue;
    if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  let body;
  if (!["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase())) {
    try {
      const raw = await readRawBody(req);
      body = raw.length > 0 ? raw : undefined;
    } catch (error) {
      if (error?.code === "PROXY_BODY_TOO_LARGE") {
        return res.status(413).json({
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body is too large."
          }
        });
      }
      throw error;
    }
  }

  try {
    const upstreamResponse = await fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: "manual"
    });

    res.status(upstreamResponse.status);
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);

    const payload = Buffer.from(await upstreamResponse.arrayBuffer());
    return res.send(payload);
  } catch (error) {
    console.error("Staging API proxy failed", error);
    return res.status(502).json({
      error: {
        code: "UPSTREAM_API_UNAVAILABLE",
        message: "The staging API could not be reached."
      }
    });
  }
}
