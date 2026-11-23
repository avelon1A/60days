import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import handler from "./api/index.js";
import { startLeetcodePoller } from "./lib/leetcode.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(path.dirname(new URL(import.meta.url).pathname), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8" };

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) return handler(req, res);
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(PUBLIC, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404; res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`60 Day Prep dev server on http://localhost:${PORT}`);
  startLeetcodePoller();
});
