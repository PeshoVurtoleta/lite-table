/**
 * Zero-dep static file server for the lite-table demo.
 *
 *   node demo/serve.js          # serves on http://localhost:3000
 *   PORT=8080 node demo/serve.js
 *
 * Serves the whole package root so demo/index.html can resolve
 * `../node_modules/@zakkster/...` for the importmap. Make sure peer deps
 * are installed first (`npm install`).
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".mjs":  "application/javascript; charset=utf-8",
    ".ts":   "application/typescript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt":  "text/plain; charset=utf-8",
    ".md":   "text/markdown; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
    ".ico":  "image/x-icon"
};

createServer(async (req, res) => {
    let url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/" || url === "") url = "/demo/index.html";
    if (url.endsWith("/")) url += "index.html";

    const filePath = normalize(join(ROOT, url));

    // Path traversal guard.
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    try {
        const s = await stat(filePath);
        if (s.isDirectory()) {
            res.writeHead(301, { Location: url + "/" });
            res.end();
            return;
        }
        const data = await readFile(filePath);
        const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
            "Content-Type": type,
            "Cache-Control": "no-cache"
        });
        res.end(data);
    } catch (_e) {
        res.writeHead(404);
        res.end("Not found: " + url);
    }
}).listen(PORT, () => {
    console.log("lite-table demo -> http://localhost:" + PORT + "/demo/");
    console.log("press ctrl+c to stop");
});
