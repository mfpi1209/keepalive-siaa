import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { parseCurl, ping, postForm } from "./siaa.mjs";

const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 600);
const PORT = Number(process.env.PORT || 3000);
const TZ = "America/Sao_Paulo";
const UI = new URL("./ui.html", import.meta.url);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});
pool.on("error", (error) => {
  console.error(`${stamp()}  postgres: ${error.message}`);
});

const FILA = "50631004,50631027,50631980,50629344,50623744,50623001,50631977,50631993,50625515,50625527,50627146,50629972,50632197,50633132,50631551,50629760,50627899,50628640,50631646,50628021,50631814,50631965,50626469,50627544,50626752,50627496,50632731,50634763,50631888,50630939,50632213,50630778,50627227,50626337,50626264,50625683,50625616,50628836,50629522,50627767,50628593,50629488,50627856,50627384,50630130,50626370,50627805,50633110,50629450,50626523,50628101,50625750".split(",");

let timer = null;
let alunoTimer = null;
let stopped = false;
let generation = 0;
let alunoGeneration = 0;
let rearm = async () => {};

function argValue(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Faltou o valor de ${flag}`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function stamp() {
  return new Date().toLocaleString("pt-BR", { timeZone: TZ });
}

function defaultInterval() {
  const value = Number.isFinite(INTERVAL_SEC) ? Math.round(INTERVAL_SEC) : 600;
  return Math.min(24 * 60 * 60, Math.max(60, value));
}

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function wallToDate(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const seen = zonedParts(new Date(guess));
  const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return new Date(guess - (seenUtc - guess));
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseDays(value) {
  const days = [...new Set(String(value || "").split(",").map(Number).filter((day) => day >= 1 && day <= 7))];
  days.sort((a, b) => a - b);
  return days;
}

function shiftDate(year, month, day, add) {
  const utc = new Date(Date.UTC(year, month - 1, day + add));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function weekdayNumber(year, month, day) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(wallToDate(year, month, day, 12, 0));
  return WEEKDAYS[name];
}

function nextRunAt(startTime, endTime, intervalSec, weekdays, now = new Date()) {
  const allowed = new Set(parseDays(weekdays));
  const [startHour, startMinute] = String(startTime || "07:00").split(":").map(Number);
  const [endHour, endMinute] = String(endTime || "22:00").split(":").map(Number);
  const step = Math.max(60, Number(intervalSec) || 600) * 1000;
  const today = zonedParts(now);
  for (let add = 0; add < 8; add++) {
    const day = shiftDate(today.year, today.month, today.day, add);
    if (!allowed.has(weekdayNumber(day.year, day.month, day.day))) continue;
    const start = wallToDate(day.year, day.month, day.day, startHour, startMinute);
    const end = wallToDate(day.year, day.month, day.day, endHour, endMinute);
    if (end.getTime() <= start.getTime()) continue;
    if (now.getTime() < start.getTime()) return start;
    if (now.getTime() >= end.getTime()) continue;
    const next = new Date(start.getTime() + (Math.floor((now.getTime() - start.getTime()) / step) + 1) * step);
    if (next.getTime() < end.getTime()) return next;
  }
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

function parseScheduleInput(body) {
  const startTime = String(body.startTime || "");
  const endTime = String(body.endTime || "");
  const intervalMin = Number(body.intervalMin);
  const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);
  if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) throw new Error("Horário inválido. Use HH:MM.");
  if (endTime <= startTime) throw new Error("O fim precisa ser depois do início.");
  if (!days.length) throw new Error("Escolha ao menos um dia.");
  if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 1440) {
    throw new Error("Intervalo precisa ser de 1 a 1440 minutos.");
  }
  return { startTime, endTime, intervalSec: intervalMin * 60, weekdays: days.join(",") };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      url TEXT NOT NULL,
      referer TEXT NOT NULL,
      user_agent TEXT NOT NULL,
      cookie TEXT NOT NULL,
      view_state TEXT NOT NULL,
      form_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS envios (
      id BIGSERIAL PRIMARY KEY,
      aluno TEXT,
      status INTEGER NOT NULL,
      ok BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS schedule (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      start_time TEXT NOT NULL,
      interval_sec INTEGER NOT NULL,
      last_ok BOOLEAN,
      last_message TEXT,
      last_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `INSERT INTO schedule (id, start_time, interval_sec)
     VALUES (1, '07:00', $1)
     ON CONFLICT (id) DO NOTHING`,
    [defaultInterval()],
  );
  await pool.query(`ALTER TABLE schedule ADD COLUMN IF NOT EXISTS end_time TEXT NOT NULL DEFAULT '22:00'`);
  await pool.query(`ALTER TABLE schedule ADD COLUMN IF NOT EXISTS weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7'`);
  await pool.query(`ALTER TABLE schedule ADD COLUMN IF NOT EXISTS last_aluno_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE schedule ADD COLUMN IF NOT EXISTS next_ping_at TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alunos (
      rgm TEXT PRIMARY KEY,
      posicao INTEGER NOT NULL,
      nome TEXT,
      ok BOOLEAN,
      updated_at TIMESTAMPTZ
    )
  `);
  await pool.query(`DELETE FROM alunos WHERE NOT (rgm = ANY($1::text[]))`, [FILA]);
  await pool.query(
    `INSERT INTO alunos (rgm, posicao)
     SELECT rgm, ordinality - 1 FROM unnest($1::text[]) WITH ORDINALITY AS fila(rgm, ordinality)
     ON CONFLICT (rgm) DO UPDATE SET posicao = EXCLUDED.posicao`,
    [FILA],
  );
  await pool.query("UPDATE alunos SET nome = NULL, ok = NULL, updated_at = NULL WHERE (nome = 'PAMELA CRISTINA DA SILVA' AND rgm <> '50631980' AND updated_at < TIMESTAMPTZ '2026-10-22 14:30:00+00') OR (rgm = '50631551' AND nome = 'GUSTAVO NASCIMENTO BARBOSA' AND updated_at < TIMESTAMPTZ '2026-10-22 15:30:00+00')");
}

function rowToSession(row) {
  if (!row) return null;
  return {
    url: row.url,
    referer: row.referer,
    userAgent: row.user_agent,
    cookie: row.cookie,
    viewState: row.view_state,
    form: row.form_json,
    updatedAt: row.updated_at,
  };
}

async function loadSession() {
  const { rows } = await pool.query("SELECT * FROM session WHERE id = 1");
  return rowToSession(rows[0]);
}

async function loadSchedule() {
  const { rows } = await pool.query("SELECT * FROM schedule WHERE id = 1");
  return rows[0];
}

async function saveSession(session) {
  await pool.query(
    `INSERT INTO session (id, url, referer, user_agent, cookie, view_state, form_json, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       url = EXCLUDED.url,
       referer = EXCLUDED.referer,
       user_agent = EXCLUDED.user_agent,
       cookie = EXCLUDED.cookie,
       view_state = EXCLUDED.view_state,
       form_json = EXCLUDED.form_json,
       updated_at = now()`,
    [session.url, session.referer, session.userAgent, session.cookie, session.viewState, JSON.stringify(session.form)],
  );
}

async function remember(ok, message) {
  await pool.query(
    "UPDATE schedule SET last_ok = $1, last_message = $2, last_at = now() WHERE id = 1",
    [ok, String(message || "").slice(0, 180)],
  );
}

async function applyResult(session, result) {
  session.viewState = result.nextViewState;
  session.cookie = result.cookie;
  session.form["javax.faces.ViewState"] = result.nextViewState;
  await saveSession(session);
}

async function enviarAluno(aluno) {
  const session = await loadSession();
  if (!session) throw new Error("sem sessão. Cole uma cURL para reviver.");
  const params = new URLSearchParams(session.form);
  params.set("javax.faces.ViewState", session.viewState);
  params.set("formPrincipal:filterAluno", aluno);
  const result = await postForm(session, params);
  if (result.alive) {
    session.form["formPrincipal:filterAluno"] = aluno;
    await applyResult(session, result);
  }
  await pool.query("INSERT INTO envios (aluno, status, ok) VALUES ($1, $2, $3)", [aluno, result.status, result.alive]);
  return result;
}

async function tick() {
  try {
    const session = await loadSession();
    if (!session) {
      console.log(`${stamp()}  sem sessão.`);
      await remember(false, "sem sessão");
      return { ok: false, message: "sem sessão" };
    }
    const result = await ping(session);
    if (result.login || !result.alive) {
      const message = result.login
        ? "sessão expirada"
        : (result.error || `HTTP ${result.status} sem ViewState`);
      console.error(`${stamp()}  ${message}`);
      await remember(false, message);
      return { ok: false, message };
    }
    await applyResult(session, result);
    console.log(`${stamp()}  sessão ativa.`);
    await remember(true, "sessão ativa");
    return { ok: true, message: "sessão ativa" };
  } catch (error) {
    console.error(`${stamp()}  falha de rede: ${error.message}`);
    await remember(false, error.message).catch(() => {});
    return { ok: false, message: error.message };
  }
}

function insideWindow(schedule, date) {
  const parts = zonedParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  const [startHour, startMinute] = String(schedule.start_time || "07:00").split(":").map(Number);
  const [endHour, endMinute] = String(schedule.end_time || "22:00").split(":").map(Number);
  const allowed = parseDays(schedule.weekdays).includes(weekdayNumber(parts.year, parts.month, parts.day));
  return allowed && minutes >= startHour * 60 + startMinute && minutes < endHour * 60 + endMinute;
}

function nextAlunoAt(schedule, last, now = new Date()) {
  const earliest = last ? new Date(new Date(last).getTime() + 60 * 60 * 1000) : new Date(now.getTime() + 20000);
  const target = earliest > now ? earliest : now;
  if (insideWindow(schedule, target)) return target;
  return nextRunAt(schedule.start_time, schedule.end_time, 86400, schedule.weekdays, new Date(target.getTime() - 1000));
}

async function consultarProximo() {
  const picked = await pool.query("SELECT rgm FROM alunos ORDER BY updated_at NULLS FIRST, posicao LIMIT 1");
  const rgm = picked.rows[0]?.rgm;
  if (!rgm) return;
  try {
    const result = await enviarAluno(rgm);
    if (result.alive) {
      await pool.query(
        "UPDATE alunos SET nome = $2, ok = $3, updated_at = now() WHERE rgm = $1",
        [rgm, result.nome || null, Boolean(result.nome)],
      );
    }
    console.log(`${stamp()}  aluno ${rgm} ${result.alive && result.nome ? "ok" : "falha"}.`);
  } finally {
    await pool.query("UPDATE schedule SET last_aluno_at = now() WHERE id = 1");
  }
}

async function statusPayload() {
  const [session, schedule] = await Promise.all([loadSession(), loadSchedule()]);
  const next = schedule.next_ping_at ? new Date(schedule.next_ping_at) : randomPingAt(schedule);
  return {
    session: Boolean(session),
    updatedAt: session?.updatedAt || null,
    schedule: {
      startTime: schedule.start_time,
      endTime: schedule.end_time,
      days: parseDays(schedule.weekdays),
      intervalMin: Math.round(schedule.interval_sec / 60),
      nextRun: next.toISOString(),
      nextRunLabel: next.toLocaleString("pt-BR", { timeZone: TZ }),
      nextAlunoLabel: nextAlunoAt(schedule, schedule.last_aluno_at).toLocaleString("pt-BR", { timeZone: TZ }),
    },
    last: { ok: schedule.last_ok, message: schedule.last_message || "", at: schedule.last_at },
  };
}

function authorized(req) {
  const token = process.env.AUTH_TOKEN || "";
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_500_000) {
        reject(new Error("corpo grande demais"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, payload, type = "application/json; charset=utf-8") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function handle(req, res) {
  const path = new URL(req.url || "/", "http://local").pathname;
  if (req.method === "GET" && path === "/ok.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" }); res.end(await readFile(new URL("./ok.jpg", import.meta.url))); return; }
  if (req.method === "GET" && path === "/") {
    send(res, 200, await readFile(UI, "utf8"), "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && path === "/health") {
    const session = await loadSession();
    send(res, 200, { ok: true, session: Boolean(session) });
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { error: "não autorizado" });
    return;
  }
  if (req.method === "GET" && path === "/status") {
    send(res, 200, await statusPayload());
    return;
  }
  if (req.method === "POST" && path === "/schedule") {
    const parsed = parseScheduleInput(JSON.parse((await readBody(req)) || "{}"));
    await pool.query(
      `UPDATE schedule SET start_time = $1, end_time = $2, interval_sec = $3, weekdays = $4, updated_at = now() WHERE id = 1`,
      [parsed.startTime, parsed.endTime, parsed.intervalSec, parsed.weekdays],
    );
    await rearm();
    send(res, 200, await statusPayload());
    return;
  }
  if (req.method === "POST" && path === "/session") {
    const session = parseCurl(await readBody(req));
    await saveSession(session);
    const revived = await tick();
    send(res, revived.ok ? 200 : 409, { ok: revived.ok, message: revived.message });
    return;
  }
  if (req.method === "GET" && path === "/alunos") {
    const { rows } = await pool.query("SELECT rgm, nome, ok, updated_at FROM alunos ORDER BY posicao");
    send(res, 200, rows.map((row) => ({
      rgm: row.rgm,
      nome: row.nome || "",
      ok: row.ok === true,
      at: row.updated_at,
    })));
    return;
  }
  if (req.method === "POST" && path === "/alunos") {
    const aluno = String(JSON.parse((await readBody(req)) || "{}").aluno || "").trim();
    if (!/^\d{4,12}$/.test(aluno)) {
      send(res, 400, { ok: false, error: "RGM inválido" });
      return;
    }
    const result = await enviarAluno(aluno);
    if (result.login || !result.alive) {
      send(res, 409, { ok: false });
      return;
    }
    send(res, 200, { ok: true, nome: result.nome || "" });
    return;
  }
  send(res, 404, { error: "não encontrado" });
}

async function seed() {
  if (process.env.SIAA_CURL) {
    await saveSession(parseCurl(process.env.SIAA_CURL));
    console.log("sessão gravada a partir de SIAA_CURL");
    return;
  }
  const curlPath = argValue("curl") || process.env.CURL_FILE;
  if (!curlPath) return;
  await saveSession(parseCurl(await readFile(curlPath, "utf8")));
  console.log("sessão gravada a partir do arquivo cURL");
}

function randomPingAt(schedule, now = new Date()) {
  const candidate = new Date(now.getTime() + (8 + Math.floor(Math.random() * 15)) * 60000);
  if (insideWindow(schedule, candidate)) return candidate;
  const open = nextRunAt(schedule.start_time, schedule.end_time, 86400, schedule.weekdays, candidate);
  const shifted = new Date(open.getTime() + (2 + Math.floor(Math.random() * 16)) * 60000);
  return insideWindow(schedule, shifted) ? shifted : open;
}
async function arm() {
  if (stopped) return;
  const ticket = ++generation;
  clearTimeout(timer);
  const schedule = await loadSchedule();
  if (ticket !== generation || stopped) return;
  const next = randomPingAt(schedule);
  await pool.query("UPDATE schedule SET next_ping_at = $1 WHERE id = 1", [next]);
  const delay = Math.max(0, next.getTime() - Date.now());
  timer = setTimeout(() => {
    tick()
      .catch((error) => console.error(`${stamp()}  ${error.message}`))
      .finally(() => arm().catch((error) => console.error(`${stamp()}  ${error.message}`)));
  }, delay);
  console.log(`${stamp()}  próximo ping ${next.toLocaleString("pt-BR", { timeZone: TZ })}.`);
}

async function armAluno() {
  if (stopped) return;
  const ticket = ++alunoGeneration;
  clearTimeout(alunoTimer);
  const schedule = await loadSchedule();
  if (ticket !== alunoGeneration || stopped) return;
  const next = nextAlunoAt(schedule, schedule.last_aluno_at);
  alunoTimer = setTimeout(() => {
    consultarProximo()
      .catch((error) => console.error(`${stamp()}  aluno: ${error.message}`))
      .finally(() => armAluno().catch((error) => console.error(`${stamp()}  ${error.message}`)));
  }, Math.max(0, next.getTime() - Date.now()));
  console.log(`${stamp()}  próximo aluno ${next.toLocaleString("pt-BR", { timeZone: TZ })}.`);
}
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Defina DATABASE_URL.");
  if (!process.env.AUTH_TOKEN) throw new Error("Defina AUTH_TOKEN.");
  if (!Number.isFinite(INTERVAL_SEC) || INTERVAL_SEC < 30) {
    throw new Error("INTERVAL_SEC precisa ser um número de segundos >= 30.");
  }
  await ensureSchema();
  await seed();
  if (hasFlag("once")) {
    await tick();
    await pool.end();
    return;
  }
  rearm = arm;
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(`${stamp()}  ${error.message}`);
      if (!res.headersSent) send(res, 400, { error: error.message });
    });
  });
  server.listen(PORT, () => {
    console.log(`porta ${PORT}.`);
  });
  await arm();
  await armAluno();
  process.on("SIGINT", async () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(alunoTimer);
    server.close();
    await pool.end();
    process.exit(0);
  });
}
main().catch(async (error) => {
  console.error(error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
