import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import webPush from "web-push";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DATA = path.join(DATA_DIR, "store.json");
const PUSH_KEYS_FILE = path.join(DATA_DIR, "push-vapid.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "web.push.apple.com"]);
const PUSH_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const PORT = Number(process.env.PORT) || 8787;

function load() {
  let store;
  try {
    store = JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    store = { booths: [], requests: [], messages: [] };
  }
  if (!Array.isArray(store.booths) || !Array.isArray(store.requests)) {
    throw new Error("invalid store");
  }
  if (store.messages == null) store.messages = [];
  if (!Array.isArray(store.messages)) throw new Error("invalid messages");
  let dirty = false;
  const requestIds = new Set(store.messages.map((item) => item.requestId).filter(Boolean));
  for (const request of store.requests || []) {
    if (requestIds.has(request.id)) continue;
    store.messages.push({
      id: randomUUID(),
      boothId: request.boothId,
      requestId: request.id,
      from: "booth",
      text: request.text,
      createdAt: request.createdAt,
    });
    requestIds.add(request.id);
    dirty = true;
  }
  if (dirty) save(store);
  return store;
}

function save(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${DATA}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
  fs.renameSync(temporary, DATA);
}

function writePrivateJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function loadVapidKeys() {
  try {
    const keys = JSON.parse(fs.readFileSync(PUSH_KEYS_FILE, "utf8"));
    if (typeof keys.publicKey === "string" && typeof keys.privateKey === "string") return keys;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const keys = webPush.generateVAPIDKeys();
  writePrivateJson(PUSH_KEYS_FILE, keys);
  return keys;
}

function loadPushSubscriptions() {
  try {
    const subscriptions = JSON.parse(fs.readFileSync(PUSH_SUBSCRIPTIONS_FILE, "utf8"));
    if (Array.isArray(subscriptions)) return subscriptions;
    throw new Error("invalid push subscription file");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function savePushSubscriptions(subscriptions) {
  writePrivateJson(PUSH_SUBSCRIPTIONS_FILE, subscriptions);
}

function validEndpoint(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || !PUSH_HOSTS.has(endpoint.hostname)) return null;
    if (endpoint.username || endpoint.password || (endpoint.port && endpoint.port !== "443")) return null;
    if (endpoint.pathname.length < 2 || endpoint.hash) return null;
    return endpoint.href;
  } catch {
    return null;
  }
}

function validateSubscription(input) {
  if (!input || typeof input !== "object") return null;
  const endpoint = validEndpoint(input.endpoint);
  const p256dh = input.keys?.p256dh;
  const auth = input.keys?.auth;
  if (!endpoint || typeof p256dh !== "string" || p256dh.length > 512 ||
      typeof auth !== "string" || auth.length > 512 || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function removePushEndpoint(endpoint) {
  const subscriptions = loadPushSubscriptions();
  const next = subscriptions.filter((item) => item.endpoint !== endpoint);
  if (next.length !== subscriptions.length) savePushSubscriptions(next);
}

function removeBoothPushSubscriptions(boothId) {
  const subscriptions = loadPushSubscriptions();
  const next = subscriptions.filter((item) => item.role !== "booth" || item.boothId !== boothId);
  if (next.length !== subscriptions.length) savePushSubscriptions(next);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error("too big"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function routePush(method, url, body) {
  if (method === "GET" && url.pathname === "/api/push/public-key") {
    return { status: 200, body: { publicKey: loadVapidKeys().publicKey } };
  }

  if (url.pathname === "/api/push/subscriptions" && method === "POST") {
    const subscription = validateSubscription(body.subscription);
    if (!subscription || !["booth", "control"].includes(body.role)) {
      return { status: 400, body: { error: "invalid push subscription" } };
    }
    let boothId;
    if (body.role === "booth") {
      boothId = clip(body.boothId, 100);
      if (!boothId || !load().booths.some((item) => item.id === boothId)) {
        return { status: 400, body: { error: "booth not found" } };
      }
    }
    const subscriptions = loadPushSubscriptions().filter((item) => item.endpoint !== subscription.endpoint);
    subscriptions.push({ ...subscription, role: body.role, ...(boothId ? { boothId } : {}) });
    savePushSubscriptions(subscriptions);
    return { status: 201, body: { ok: true } };
  }

  if (url.pathname === "/api/push/subscriptions" && method === "DELETE") {
    const endpoint = validEndpoint(body.endpoint);
    if (!endpoint) return { status: 400, body: { error: "invalid endpoint" } };
    removePushEndpoint(endpoint);
    return { status: 204, body: "" };
  }

  return null;
}

function route(store, method, url, body) {
  if (method === "GET" && url.pathname === "/api/state") {
    return { status: 200, body: store };
  }

  if (method === "POST" && url.pathname === "/api/booths") {
    const name = clip(body.name, 40);
    const staff = clip(body.staff, 40);
    if (!name || !staff) return { status: 400, body: { error: "name and staff required" } };
    const booth = {
      id: randomUUID(),
      name,
      staff,
      level: "ok",
      createdAt: Date.now(),
    };
    store.booths.push(booth);
    save(store);
    return { status: 201, body: booth };
  }

  const boothMatch = url.pathname.match(/^\/api\/booths\/([^/]+)$/);
  if (boothMatch && method === "PATCH") {
    const booth = store.booths.find((item) => item.id === boothMatch[1]);
    if (!booth) return { status: 404, body: { error: "booth not found" } };
    if (!["full", "mid", "ok"].includes(body.level)) {
      return { status: 400, body: { error: "bad level" } };
    }
    booth.level = body.level;
    save(store);
    return { status: 200, body: booth };
  }

  if (boothMatch && method === "DELETE") {
    const before = store.booths.length;
    store.booths = store.booths.filter((item) => item.id !== boothMatch[1]);
    if (store.booths.length === before) return { status: 404, body: { error: "booth not found" } };
    save(store);
    removeBoothPushSubscriptions(boothMatch[1]);
    return { status: 204, body: "" };
  }

  if (method === "POST" && url.pathname === "/api/requests") {
    const booth = store.booths.find((item) => item.id === body.boothId);
    const text = clip(body.text, 200);
    if (!booth || !text) return { status: 400, body: { error: "booth and text required" } };
    const request = {
      id: randomUUID(),
      boothId: booth.id,
      boothName: booth.name,
      staff: booth.staff,
      text,
      status: "new",
      createdAt: Date.now(),
    };
    store.requests.push(request);
    store.messages.push({
      id: randomUUID(),
      boothId: booth.id,
      requestId: request.id,
      from: "booth",
      text,
      createdAt: request.createdAt,
    });
    save(store);
    return { status: 201, body: request };
  }

  if (method === "POST" && url.pathname === "/api/messages") {
    const booth = store.booths.find((item) => item.id === body.boothId);
    const text = clip(body.text, 200);
    if (!booth || !text) return { status: 400, body: { error: "booth and text required" } };
    const message = {
      id: randomUUID(),
      boothId: booth.id,
      from: "control",
      text,
      createdAt: Date.now(),
    };
    store.messages.push(message);
    save(store);
    return { status: 201, body: message };
  }

  const requestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)$/);
  if (requestMatch && method === "PATCH") {
    const request = store.requests.find((item) => item.id === requestMatch[1]);
    if (!request) return { status: 404, body: { error: "request not found" } };
    if (body.status !== "doing") return { status: 400, body: { error: "bad status" } };
    request.status = "doing";
    save(store);
    return { status: 200, body: request };
  }

  if (requestMatch && method === "DELETE") {
    const before = store.requests.length;
    store.requests = store.requests.filter((item) => item.id !== requestMatch[1]);
    if (store.requests.length === before) return { status: 404, body: { error: "request not found" } };
    save(store);
    return { status: 204, body: "" };
  }

  return null;
}

async function dispatchPush(boothId, targetRole) {
  const subscriptions = loadPushSubscriptions().filter((item) =>
    item.role === targetRole && (targetRole !== "booth" || item.boothId === boothId));
  if (!subscriptions.length) return;
  const keys = loadVapidKeys();
  webPush.setVapidDetails(PUSH_SUBJECT, keys.publicKey, keys.privateKey);
  const payload = JSON.stringify({
    title: "새 대화",
    body: "새 대화 메시지가 도착했습니다.",
    boothId,
    targetRole,
  });
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification(subscription, payload, { TTL: 60 });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        try { removePushEndpoint(subscription.endpoint); } catch { /* Keep the saved message successful. */ }
        return;
      }
      console.error("Web Push delivery failed", Number.isInteger(error.statusCode) ? error.statusCode : "unknown");
    }
  }));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      const result = url.pathname.startsWith("/api/push/")
        ? routePush(req.method, url, body)
        : route(load(), req.method, url, body);
      if (!result) {
        send(res, 404, { error: "not found" });
        return;
      }
      if (result.status === 204) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
      } else {
        send(res, result.status, result.body);
      }
      if (result.status >= 200 && result.status < 300 && req.method === "POST") {
        if (url.pathname === "/api/requests") {
          queueMicrotask(() => dispatchPush(result.body.boothId, "control").catch(() => {
            console.error("Web Push dispatch failed");
          }));
        } else if (url.pathname === "/api/messages") {
          queueMicrotask(() => dispatchPush(result.body.boothId, "booth").catch(() => {
            console.error("Web Push dispatch failed");
          }));
        }
      }
    } catch (error) {
      const badRequest = error.message === "bad json" || error.message === "too big";
      if (!badRequest) console.error("Request processing failed");
      if (!res.headersSent && !res.destroyed) {
        send(res, badRequest ? 400 : 500, { error: badRequest ? "bad request" : "server error" });
      }
    }
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  const nets = Object.values(os.networkInterfaces()).flat();
  const lan = nets.find((item) => item && item.family === "IPv4" && !item.internal);
  console.log(`bazaar desk http://localhost:${PORT}`);
  if (lan) console.log(`same wifi http://${lan.address}:${PORT}`);
});
