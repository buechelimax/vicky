// The site's small server. It serves the files in public/ and keeps the dictionary.
// Words live in a Cloudflare Durable Object (a tiny database). Vicky's suggestions wait
// until Noemi accepts them. Noemi proves it's her with the key below (the review link).
import { DurableObject } from "cloudflare:workers";

const KEY = "oBgbMwMrdXSvNz72";

// The words that are there from the start. Noemi can edit or delete them on the site.
const SEED = [
  {
    word: "double cheeked up on a thursday afternoon",
    kind: "phrase",
    meaning: "fill in ur text here",
    also: "double cheeked up, cheeked up, on a thursday afternoon"
  },
  {
    word: "on a [insert day]",
    kind: "phrase",
    meaning: "Goes after anything out of the ordinary, to say it is happening on a day that is usually normal.",
    also: "on a thursday afternoon"
  },
  {
    word: "dogs",
    kind: "noun, plural",
    meaning: "1. feet\n2. hot dogs",
    also: ""
  }
];

const LIMITS = { word: 80, kind: 40, meaning: 600, also: 200, pending: 60 };

function clean(v, max) { return String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, max); }

export class Dictionary extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', meaning TEXT NOT NULL DEFAULT '',
      also TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL)`);
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM words").one().n;
    if (n === 0) {
      for (const w of SEED) {
        this.sql.exec("INSERT INTO words (word, kind, meaning, also, by, status, created) VALUES (?, ?, ?, ?, 'noemi', 'ok', ?)",
          w.word, w.kind, w.meaning, w.also, Date.now());
      }
    }
  }
  rows(status) {
    return this.sql.exec("SELECT id, word, kind, meaning, also, by FROM words WHERE status = ? ORDER BY word COLLATE NOCASE", status).toArray();
  }
  list() { return this.rows("ok"); }
  pending() { return this.sql.exec("SELECT id, word, kind, meaning, also, by FROM words WHERE status = 'pending' ORDER BY created").toArray(); }
  mine(ids) {
    if (!ids.length) return [];
    return this.sql.exec(`SELECT id, status FROM words WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids).toArray();
  }
  add(w, isNoemi) {
    const word = clean(w.word, LIMITS.word);
    if (!word) return { error: "empty" };
    if (!isNoemi) {
      const p = this.sql.exec("SELECT COUNT(*) AS n FROM words WHERE status = 'pending'").one().n;
      if (p >= LIMITS.pending) return { error: "full" };
    }
    const row = this.sql.exec(
      "INSERT INTO words (word, kind, meaning, also, by, status, created) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      word, clean(w.kind, LIMITS.kind), clean(w.meaning, LIMITS.meaning), clean(w.also, LIMITS.also),
      isNoemi ? "noemi" : "vicky", isNoemi ? "ok" : "pending", Date.now()).one();
    return { id: row.id, status: isNoemi ? "ok" : "pending" };
  }
  edit(w) {
    this.sql.exec("UPDATE words SET word = ?, kind = ?, meaning = ?, also = ? WHERE id = ?",
      clean(w.word, LIMITS.word), clean(w.kind, LIMITS.kind), clean(w.meaning, LIMITS.meaning), clean(w.also, LIMITS.also), +w.id);
    return { ok: true };
  }
  setStatus(id, status) { this.sql.exec("UPDATE words SET status = ? WHERE id = ?", status, +id); return { ok: true }; }
  remove(id) { this.sql.exec("DELETE FROM words WHERE id = ?", +id); return { ok: true }; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const db = env.DICT.get(env.DICT.idFromName("main"));
    const isNoemi = request.headers.get("x-key") === KEY;
    const route = request.method + " " + url.pathname;
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
    }

    if (route === "GET /api/words") return json(await db.list());
    if (route === "GET /api/mine") {
      const ids = (url.searchParams.get("ids") || "").split(",").map(Number).filter((n) => n > 0).slice(0, 50);
      return json(await db.mine(ids));
    }
    if (route === "POST /api/words") {
      const r = await db.add(body, isNoemi);
      return json(r, r.error ? 400 : 200);
    }

    // Everything below is only for Noemi
    if (!isNoemi) return json({ error: "not allowed" }, 401);
    if (route === "GET /api/pending") return json(await db.pending());
    if (route === "POST /api/review") {
      if (body.action === "accept") { if (body.word) await db.edit(body); return json(await db.setStatus(body.id, "ok")); }
      if (body.action === "reject") return json(await db.setStatus(body.id, "no"));
    }
    if (route === "POST /api/edit") return json(await db.edit(body));
    if (route === "POST /api/delete") return json(await db.remove(body.id));
    return json({ error: "not found" }, 404);
  }
};
