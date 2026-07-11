/**
 * index.ts — Bun server entry point for Testbook Paper Room.
 *
 * Usage:
 *   cd server
 *   bun run index.ts
 *
 * The server reads BEARER_TOKEN from the .env file next to this script.
 */

import { handleApi } from "./routes";
import { initAuth, requireAuth, login, extractToken, validateToken } from "./auth";

const PORT = parseInt(process.env.PORT || "4487");

await initAuth();

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── Login endpoint (no auth required) ──────────────────────────
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      try {
        const body = await req.json();
        const { email, password } = body;
        if (!email || !password) {
          return new Response(JSON.stringify({ error: "Email and password are required." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const token = login(email, password);
        if (!token) {
          return new Response(JSON.stringify({ error: "Invalid email or password." }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return new Response(JSON.stringify({ error: "Invalid request." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ── API routes (auth required) ─────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const authErr = requireAuth(req);
      if (authErr) return authErr;
      const apiRes = await handleApi(req);
      if (apiRes) return apiRes;
      return new Response(JSON.stringify({ error: "API route not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── App (auth required) ────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/login" || url.pathname === "/login.html") {
      const file = Bun.file(new URL("./login.html", import.meta.url));
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/app" || url.pathname === "/app/") {
      const token = extractToken(req);
      if (!token || !validateToken(token)) {
        // Redirect to login
        return new Response(null, {
          status: 302,
          headers: { Location: "/" },
        });
      }
      const file = Bun.file(new URL("./index.html", import.meta.url));
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 404
    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  📄 Testbook Paper Room`);
console.log(`  Server running at http://localhost:${server.port}\n`);
