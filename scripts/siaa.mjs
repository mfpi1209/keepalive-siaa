const ALLOWED_HOST = "siaa.cruzeirodosul.edu.br";

const VIEWSTATE_UPDATE =
  /<update id="[^"]*javax\.faces\.ViewState[^"]*"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/g;
const VIEWSTATE_INPUT =
  /name="javax\.faces\.ViewState"(?:[^>]*?)value="([^"]+)"/g;

function lastMatch(pattern, text) {
  if (!text) return "";
  pattern.lastIndex = 0;
  let found = "";
  for (const match of text.matchAll(pattern)) found = match[1];
  return found;
}

function tokenizeCurl(input) {
  const joined = input.replace(/\\\s*\r?\n/g, " ");
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && joined.slice(i, i + 4) === "'\\''") {
          current += "'";
          i += 3;
          continue;
        }
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseCurl(raw) {
  const text = raw.replace(/^﻿/, "").trim();
  if (!/^curl(\.exe)?\b/i.test(text)) {
    throw new Error("O texto não começa com curl. Copie como cURL (bash).");
  }

  const tokens = tokenizeCurl(text);
  let url = "";
  let cookie = "";
  let userAgent = "";
  let referer = "";
  let body = "";
  const headers = {};

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    const take = () => (inline !== null ? inline : tokens[++i] || "");

    if (flag === "-H" || flag === "--header") {
      const header = take();
      const colon = header.indexOf(":");
      if (colon === -1) continue;
      headers[header.slice(0, colon).trim().toLowerCase()] = header.slice(colon + 1).trim();
      continue;
    }
    if (flag === "-b" || flag === "--cookie") {
      cookie = take() || cookie;
      continue;
    }
    if (flag === "-A" || flag === "--user-agent") {
      userAgent = take() || userAgent;
      continue;
    }
    if (flag === "-e" || flag === "--referer" || flag === "--referrer") {
      referer = take() || referer;
      continue;
    }
    if (flag === "-d" || flag === "--data" || flag === "--data-raw" || flag === "--data-binary") {
      body = take() || body;
      continue;
    }
    if (flag === "--url") {
      url = take() || url;
      continue;
    }
    if (flag === "-X" || flag === "--request") {
      take();
      continue;
    }
    if (token.startsWith("-")) continue;
    if (!url && /^https?:\/\//i.test(token)) url = token;
  }

  cookie = headers.cookie || cookie;
  userAgent = userAgent || headers["user-agent"] || "";
  referer = referer || headers.referer || "";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("A curl não tem uma URL https válida.");
  }
  if (parsed.hostname !== ALLOWED_HOST) {
    throw new Error(`A curl precisa ser de ${ALLOWED_HOST}.`);
  }

  const viewState = new URLSearchParams(body).get("javax.faces.ViewState") || "";
  if (!cookie) throw new Error("A curl não tem Cookie.");
  if (!viewState) throw new Error("A curl não tem javax.faces.ViewState.");

  const form = {};
  for (const [key, value] of new URLSearchParams(body)) form[key] = value;
  return {
    url: parsed.origin + parsed.pathname,
    cookie,
    userAgent,
    referer: referer || parsed.origin + parsed.pathname,
    viewState,
    form,
  };
}

function classify(status, location, text) {
  const visible = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const lower = `${location || ""}\n${visible.slice(0, 4000)}`.toLowerCase();
  const login =
    (status >= 300 && status < 400) ||
    status === 401 ||
    status === 403 ||
    /login|sess[aã]o expir|j_security_check|fa[cç]a o login/.test(lower);
  const errorName = text.match(/<error-name>([^<]*)<\/error-name>/)?.[1] || "";
  const errorMessage = text.match(/<error-message>([^<]*)<\/error-message>/)?.[1] || "";
  const nextViewState = (
    lastMatch(VIEWSTATE_UPDATE, text) || lastMatch(VIEWSTATE_INPUT, text)
  ).trim();
  return {
    alive: status === 200 && !login && !errorName && Boolean(nextViewState),
    login,
    nextViewState,
    status,
    error: [errorName, errorMessage].filter(Boolean).join(": ").slice(0, 180),
  };
}

function mergeCookies(current, setCookies) {
  const jar = new Map();
  for (const part of current.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const raw of setCookies) {
    const pair = raw.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

export async function postForm(session, params) {
  const response = await fetch(session.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/xml, text/xml, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Faces-Request": "partial/ajax",
      "X-Requested-With": "XMLHttpRequest",
      Origin: new URL(session.url).origin,
      Referer: session.referer,
      "User-Agent": session.userAgent || "Mozilla/5.0",
      Cookie: session.cookie,
    },
    body: params,
  });
  const text = await response.text();
  const setCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const result = classify(response.status, response.headers.get("location"), text);
  result.cookie = mergeCookies(session.cookie, setCookies);
  result.nome = nomeDoAluno(text, params.get("formPrincipal:filterAluno") || "");
  return result;
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", acirc: "â", atilde: "ã", agrave: "à", ccedil: "ç",
  eacute: "é", ecirc: "ê", iacute: "í", oacute: "ó", ocirc: "ô",
  otilde: "õ", uacute: "ú", Aacute: "Á", Acirc: "Â", Atilde: "Ã",
  Agrave: "À", Ccedil: "Ç", Eacute: "É", Ecirc: "Ê", Iacute: "Í",
  Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Uacute: "Ú",
};

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match,
    );
}

// Texto visível de uma célula: remove tags aninhadas, decodifica entidades e normaliza espaços.
function cellText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// Uma célula "parece nome": só letras/espaço/.'- (acentos inclusos), nenhum dígito, 3..120 chars.
function looksLikeName(cell) {
  return (
    cell.length >= 3 &&
    cell.length <= 120 &&
    !/\d/.test(cell) &&
    /^[\p{L}][\p{L}\s.'-]*\p{L}$/u.test(cell) &&
    /\p{L}\s+\p{L}/u.test(cell) // ao menos duas palavras (nome + sobrenome)
  );
}

function nomeDoAluno(text, rgm) {
  if (!/^\d{4,12}$/.test(rgm)) return "";
  for (const row of text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      cellText(cell[1]),
    );
    const index = cells.findIndex((cell) => cell === rgm);
    if (index === -1) continue;
    // Preferência: célula imediatamente após o RGM (layout "RGM | Nome"),
    // depois a imediatamente antes ("Nome | RGM"), depois qualquer outra da linha.
    const ordered = [
      cells[index + 1],
      cells[index - 1],
      ...cells.filter((_, i) => i !== index && i !== index + 1 && i !== index - 1),
    ];
    const nome = ordered.find((cell) => cell && looksLikeName(cell));
    if (nome) return nome.slice(0, 120);
  }
  return "";
}

export function ping(session) {
  return postForm(
    session,
    new URLSearchParams({
      "javax.faces.partial.ajax": "true",
      "javax.faces.source": "formPrincipal",
      "javax.faces.partial.execute": "@none",
      "javax.faces.partial.render": "@none",
      formPrincipal: "formPrincipal",
      "javax.faces.ViewState": session.viewState,
    }),
  );
}
