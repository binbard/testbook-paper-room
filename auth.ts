/**
 * auth.ts — Simple CSV-backed authentication.
 *
 * Tokens are random strings stored in memory for the lifetime of the server
 * process. No database, no JWT — just a map that dies with the server.
 */

const sessions = new Map<string, string>(); // token → email
let _users: { email: string; password: string }[] | null = null;

async function loadUsers(): Promise<{ email: string; password: string }[]> {
  if (_users) return _users;
  _users = [];
  try {
    const file = Bun.file(new URL("./auth.csv", import.meta.url));
    const raw = await file.text();
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      const email = parts[0]?.trim();
      const password = parts.slice(1).join(",").trim(); // password may contain commas
      if (email && password) _users.push({ email, password });
    }
    console.log(`  auth: loaded ${_users.length} user(s)`);
  } catch {
    console.log("  auth: auth.csv not found — no users configured");
  }
  return _users;
}

function generateToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 48; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return "tb_" + token;
}

/** Call once at server startup to pre-load the user list. */
export async function initAuth(): Promise<void> {
  await loadUsers();
}

/** Validate credentials. Returns a session token on success, null on failure. */
export function login(email: string, password: string): string | null {
  if (!_users) return null;
  const found = _users.find(u => u.email === email && u.password === password);
  if (!found) return null;
  const token = generateToken();
  sessions.set(token, email);
  return token;
}

/** Check a Bearer token. Returns the email if valid, null otherwise. */
export function validateToken(token: string): string | null {
  if (!token) return null;
  return sessions.get(token) || null;
}

/** Extract Bearer token from an Authorization header. */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

/** Auth middleware — returns 401 if the request is not authenticated. */
export function requireAuth(req: Request): Response | null {
  const token = extractToken(req);
  if (!token || !validateToken(token)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Please log in." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  return null; // OK
}
