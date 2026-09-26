export default async function handler(req, res) {
  const upstream = process.env.UPSTREAM_API_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (!upstream || !bypassSecret) {
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
  headers["x-vercel-protection-bypass"] = bypassSecret;

  let body;
  if (!["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase())) {
    if (req.body === undefined || req.body === null) {
      body = undefined;
    } else if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      headers["content-type"] = headers["content-type"] || "application/json";
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
