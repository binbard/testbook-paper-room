/**
 * index.ts — Bun server entry point for Testbook Paper Room.
 *
 * Serves index.html as the frontend and /api/* routes as the backend.
 *
 * Usage:
 *   cd server
 *   bun run index.ts
 *
 * The server reads BEARER_TOKEN from the .env file next to this script.
 */

import { handleApi } from "./routes";

const PORT = parseInt(process.env.PORT || "4487");

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── API routes ──────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const apiRes = await handleApi(req);
      if (apiRes) return apiRes;
      return new Response(JSON.stringify({ error: "API route not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Static files ────────────────────────────────────────────────
    // Serve the main HTML for root and /index.html
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = Bun.file(new URL("./index.html", import.meta.url));
      if (!(await html.exists())) {
        return new Response("Frontend file not found", { status: 404 });
      }
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 404 for everything else
    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  📄 Testbook Paper Room`);
console.log(`  Server running at http://localhost:${server.port}\n`);
