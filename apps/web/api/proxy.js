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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
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
        message: "The staging API proxy is not configured."
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
    const raw = await readRawBody(req);
    body = raw.length > 0 ? raw : undefined;
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
