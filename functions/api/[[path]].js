// Advent of Kudos API: one Pages Function that serves every /api/* route.
//
// Bindings (Cloudflare Pages → Settings):
//   DB              D1 database binding (required)
//   ADMIN_PASSWORD  secret that unlocks the organizer panel (required for setup)
//   TRUST_ACCESS    "1" only once Cloudflare Access protects the site; kudos are
//                   then signed with the verified email instead of a browser token.

const MAX_TEXT = 500;
const MAX_NAME = 60;
const MAX_PHOTO = 400_000; // data URL characters, ~300 KB image
const DEFAULT_TZ = "Europe/Madrid";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (error, status = 400) => json({ error }, status);

// ---------- schema ----------
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      photo TEXT,
      photo_v INTEGER NOT NULL DEFAULT 0,
      ord INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kudos (
      member_id TEXT NOT NULL,
      author_key TEXT NOT NULL,
      author_name TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (member_id, author_key)
    )`),
  ]);
  schemaReady = true;
}

// ---------- dates ----------
function validTz(tz) {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; }
}
const todayIn = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

async function loadConfig(db) {
  const { results } = await db.prepare("SELECT k, v FROM settings").all();
  const raw = Object.fromEntries(results.map((r) => [r.k, r.v]));
  const tz = raw.tz && validTz(raw.tz) ? raw.tz : DEFAULT_TZ;
  const start = isDate(raw.start) ? raw.start : `${todayIn(tz).slice(0, 4)}-12-01`;
  return { start, tz };
}

// Same rule as the page: members in order, one weekday each from `start`. Nobody comes out on Saturdays or Sundays.
function schedule(members, cfg) {
  const d = new Date(cfg.start + "T00:00:00Z");
  return members.map((m, i) => {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return { ...m, day: i + 1, date };
  });
}

async function loadMembers(db) {
  const { results } = await db.prepare("SELECT id, name, role, photo IS NOT NULL AS has_photo, photo_v, ord FROM members ORDER BY ord, name").all();
  return results;
}

// ---------- identity ----------
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function accessEmail(request, env) {
  if (env.TRUST_ACCESS !== "1") return null;
  const email = request.headers.get("cf-access-authenticated-user-email");
  return email ? email.trim().toLowerCase() : null;
}
async function authorKey(request, env) {
  const email = accessEmail(request, env);
  if (email) return "e:" + email;
  const token = request.headers.get("x-author-token") || "";
  if (token.length < 20 || token.length > 200) return null;
  return "t:" + (await sha256(token));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || "";
  return !!env.ADMIN_PASSWORD && key.length > 0 && timingSafeEqual(key, env.ADMIN_PASSWORD);
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_PHOTO + 10_000) throw new Error("too_large");
  return text ? JSON.parse(text) : {};
}
const cleanText = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanPhoto(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || v.length > MAX_PHOTO || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return undefined;
  return v;
}

// ---------- routes ----------
async function getState(request, env) {
  const db = env.DB;
  const [cfg, rows] = await Promise.all([loadConfig(db), loadMembers(db)]);
  const today = todayIn(cfg.tz);
  const members = schedule(rows, cfg);
  const admin = isAdmin(request, env);
  const openIds = new Set(members.filter((m) => admin || m.date < today).map((m) => m.id));

  const { results: kudos } = await db.prepare("SELECT member_id, author_key, author_name, text, at FROM kudos ORDER BY at").all();
  const counts = {};
  const revealed = Object.fromEntries([...openIds].map((id) => [id, []]));
  for (const k of kudos) {
    counts[k.member_id] = (counts[k.member_id] || 0) + 1;
    if (openIds.has(k.member_id)) (revealed[k.member_id] ||= []).push({ name: k.author_name, text: k.text, at: k.at });
  }

  const key = await authorKey(request, env);
  const mine = {};
  if (key) for (const k of kudos) if (k.author_key === key) mine[k.member_id] = { text: k.text, name: k.author_name };

  return json({
    today,
    config: cfg,
    members: members.map((m) => ({
      id: m.id, name: m.name, role: m.role, day: m.day, date: m.date,
      photo: m.has_photo ? `/api/photo/${encodeURIComponent(m.id)}?v=${m.photo_v}` : null,
    })),
    counts,
    revealed,
    mine,
    identity: { email: accessEmail(request, env) },
    adminEnabled: !!env.ADMIN_PASSWORD,
  });
}

async function getPhoto(env, id) {
  const row = await env.DB.prepare("SELECT photo FROM members WHERE id = ?").bind(id).first();
  if (!row || !row.photo) return new Response("Not found", { status: 404 });
  const [, type, b64] = row.photo.match(/^data:(image\/[a-z]+);base64,(.*)$/) || [];
  if (!b64) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
}

async function todaysMember(db) {
  const [cfg, rows] = await Promise.all([loadConfig(db), loadMembers(db)]);
  const today = todayIn(cfg.tz);
  return schedule(rows, cfg).find((m) => m.date === today) || null;
}

async function putKudo(request, env) {
  const key = await authorKey(request, env);
  if (!key) return fail("Missing author token.", 401);
  const body = await readJson(request);
  const text = cleanText(body.text, MAX_TEXT);
  const name = cleanText(body.name, MAX_NAME);
  if (!text) return fail("Write a message first.");
  if (!name) return fail("Tell us your name first.");
  const current = await todaysMember(env.DB);
  if (!current || current.id !== body.memberId) return fail("This window isn't open today.", 409);
  await env.DB.prepare(
    `INSERT INTO kudos (member_id, author_key, author_name, text, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (member_id, author_key) DO UPDATE SET author_name = excluded.author_name, text = excluded.text, at = excluded.at`,
  ).bind(current.id, key, name, text, new Date().toISOString()).run();
  return json({ ok: true });
}

async function deleteKudo(request, env) {
  const key = await authorKey(request, env);
  if (!key) return fail("Missing author token.", 401);
  const body = await readJson(request);
  const current = await todaysMember(env.DB);
  if (!current || current.id !== body.memberId) return fail("This window isn't open today.", 409);
  await env.DB.prepare("DELETE FROM kudos WHERE member_id = ? AND author_key = ?").bind(current.id, key).run();
  return json({ ok: true });
}

async function admin(request, env, rest) {
  if (!env.ADMIN_PASSWORD) return fail("The organizer password isn't set up yet (ADMIN_PASSWORD).", 503);
  if (!isAdmin(request, env)) return fail("Wrong organizer password.", 401);
  const db = env.DB;
  const method = request.method;
  const [what, id] = rest;

  if (what === "check" && method === "GET") return json({ ok: true });

  if (what === "members" && !id && method === "POST") {
    const body = await readJson(request);
    const name = cleanText(body.name, MAX_NAME);
    const photo = cleanPhoto(body.photo);
    if (!name) return fail("Add a name.");
    if (photo === undefined) return fail("That photo can't be used. Try a JPG or PNG.");
    const max = await db.prepare("SELECT COALESCE(MAX(ord), -1) AS m FROM members").first();
    const newId = crypto.randomUUID();
    await db.prepare("INSERT INTO members (id, name, role, photo, photo_v, ord) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId, name, cleanText(body.role, MAX_NAME), photo, Date.now(), (max?.m ?? -1) + 1).run();
    return json({ ok: true, id: newId }, 201);
  }

  if (what === "members" && id && method === "PATCH") {
    const body = await readJson(request);
    const sets = [];
    const args = [];
    if ("name" in body) { const n = cleanText(body.name, MAX_NAME); if (!n) return fail("Add a name."); sets.push("name = ?"); args.push(n); }
    if ("role" in body) { sets.push("role = ?"); args.push(cleanText(body.role, MAX_NAME)); }
    if ("photo" in body) {
      const p = cleanPhoto(body.photo);
      if (p === undefined) return fail("That photo can't be used. Try a JPG or PNG.");
      sets.push("photo = ?", "photo_v = ?"); args.push(p, Date.now());
    }
    if (!sets.length) return fail("Nothing to change.");
    await db.prepare(`UPDATE members SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
    return json({ ok: true });
  }

  if (what === "members" && id && method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM kudos WHERE member_id = ?").bind(id),
      db.prepare("DELETE FROM members WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  if (what === "order" && method === "PUT") {
    const body = await readJson(request);
    if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== "string")) return fail("Send the member ids in order.");
    if (body.ids.length) await db.batch(body.ids.map((mid, i) => db.prepare("UPDATE members SET ord = ? WHERE id = ?").bind(i, mid)));
    return json({ ok: true });
  }

  if (what === "config" && method === "PUT") {
    const body = await readJson(request);
    if (!isDate(body.start)) return fail("Pick a valid first day.");
    const tz = cleanText(body.tz, 64) || DEFAULT_TZ;
    if (!validTz(tz)) return fail("That time zone isn't recognized. Try something like Europe/Madrid.");
    const put = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, v);
    await db.batch([put("start", body.start), put("tz", tz)]);
    return json({ ok: true });
  }

  return fail("Not found.", 404);
}

export async function onRequest({ request, env: rawEnv, params }) {
  // Accept the D1 binding as DB or db, since the dashboard field is case-sensitive.
  const env = { ...rawEnv, DB: rawEnv.DB || rawEnv.db };
  if (!env.DB) return fail("The D1 database isn't connected. Add a D1 binding named DB in the Pages project settings.", 503);
  const path = [].concat(params.path || []);
  const [head, ...rest] = path;
  try {
    await ensureSchema(env.DB);
    if (head === "state" && request.method === "GET") return await getState(request, env);
    if (head === "photo" && rest[0] && request.method === "GET") return await getPhoto(env, rest[0]);
    if (head === "kudos" && request.method === "PUT") return await putKudo(request, env);
    if (head === "kudos" && request.method === "DELETE") return await deleteKudo(request, env);
    if (head === "admin") return await admin(request, env, rest);
    return fail("Not found.", 404);
  } catch (err) {
    if (err instanceof SyntaxError) return fail("The request body isn't valid JSON.");
    if (err && err.message === "too_large") return fail("That request is too large.", 413);
    console.error(err);
    return fail("Something went wrong on the server. Try again in a moment.", 500);
  }
}
