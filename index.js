const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const LOG_FILE = path.join(DATA_DIR, "statuts_whatsapp.json");
const HISTORY_FILE = path.join(DATA_DIR, "historique_whatsapp.json");

// ─── Données en mémoire ───────────────────────────────
let statuts = {};
let historique = [];

function loadData() {
  try { if (fs.existsSync(LOG_FILE)) statuts = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); } catch {}
  try { if (fs.existsSync(HISTORY_FILE)) historique = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch {}
}

function saveData() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(statuts, null, 2)); } catch {}
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(historique, null, 2)); } catch {}
}

loadData();

function normalizePhone(phone) {
  phone = String(phone).trim().replace(/\s/g, "");
  if (!phone.startsWith("+")) phone = "+" + phone;
  return phone;
}

function processStatus(rawPhone, status, timestamp) {
  const phone = normalizePhone(rawPhone);
  const ts = new Date(parseInt(timestamp) * 1000).toISOString();
  const dateStr = new Date(parseInt(timestamp) * 1000).toLocaleString("fr-FR");
  if (!statuts[phone]) statuts[phone] = {};
  statuts[phone][status] = ts;
  statuts[phone].dernierStatut = status;
  const exists = historique.some(h => h.phone === phone && h.status === status && h.timestamp === ts);
  if (!exists) {
    historique.unshift({ phone, status, timestamp: ts, date: dateStr });
    if (historique.length > 5000) historique = historique.slice(0, 5000);
  }
  console.log(`[${ts}] ${phone} → ${status.toUpperCase()}`);
  saveData();
}

function processBody(data) {
  if (Array.isArray(data.statuses)) {
    data.statuses.forEach(s => processStatus(s.recipient_id || s.to, s.status, s.timestamp));
    return;
  }
  if (Array.isArray(data.entry)) {
    data.entry.forEach(entry => {
      (entry.changes || []).forEach(change => {
        (change.value?.statuses || []).forEach(s => processStatus(s.recipient_id, s.status, s.timestamp));
      });
    });
    return;
  }
  console.log("Format inconnu:", JSON.stringify(data).substring(0, 200));
}

// ─── Serveur principal ────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, D360-API-KEY");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── PROXY → 360dialog ──────────────────────────────
  if (req.method === "POST" && url === "/send") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return;
      }
      const apiKey = parsed._apiKey;
      delete parsed._apiKey;
      const payload = JSON.stringify(parsed);
      const options = {
        hostname: "waba-v2.360dialog.io",
        path: "/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "D360-API-KEY": apiKey,
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      const proxyReq = https.request(options, proxyRes => {
        let data = "";
        proxyRes.on("data", chunk => data += chunk);
        proxyRes.on("end", () => {
          res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
          res.end(data);
        });
      });
      proxyReq.on("error", err => { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); });
      proxyReq.write(payload);
      proxyReq.end();
    });
    return;
  }

  // ── WEBHOOK ← 360dialog ────────────────────────────
  if (url === "/webhook") {
    if (req.method === "GET") {
      const challenge = new URL(req.url, `http://localhost`).searchParams.get("hub.challenge");
      if (challenge) { res.writeHead(200); res.end(challenge); return; }
      res.writeHead(200); res.end("OK"); return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        res.writeHead(200); res.end("OK");
        try { processBody(JSON.parse(body)); } catch(e) { console.error("Webhook error:", e.message); }
      });
      return;
    }
  }

  // ── API statuts ────────────────────────────────────
  if (req.method === "GET" && url === "/statuts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(statuts)); return;
  }

  if (req.method === "GET" && url === "/historique") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(historique)); return;
  }

  // ── IMPORTER historique local ──────────────────────
  if (req.method === "POST" && url === "/importer") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      let imported;
      try { imported = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return;
      }
      if (!Array.isArray(imported)) {
        res.writeHead(400); res.end(JSON.stringify({ error: "Array expected" })); return;
      }
      let added = 0;
      imported.forEach(item => {
        if (!item.phone || !item.status || !item.timestamp) return;
        const phone = normalizePhone(item.phone);
        const ts = item.timestamp;
        const exists = historique.some(h => h.phone === phone && h.status === item.status && h.timestamp === ts);
        if (!exists) {
          historique.push({ phone, status: item.status, timestamp: ts, date: item.date || ts });
          added++;
          // Mettre à jour statuts si pas encore présent
          if (!statuts[phone]) statuts[phone] = {};
          if (!statuts[phone][item.status]) statuts[phone][item.status] = ts;
          statuts[phone].dernierStatut = item.status;
        }
      });
      // Trier par date décroissante
      historique.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      if (historique.length > 10000) historique = historique.slice(0, 10000);
      saveData();
      console.log(`[IMPORT] ${added} nouveaux événements importés (total: ${historique.length})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, added, total: historique.length }));
    });
    return;
  }

  // ── Health check ───────────────────────────────────
  if (req.method === "GET" && (url === "/" || url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", statuts: Object.keys(statuts).length, historique: historique.length }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Serveur WhatsApp Campaign actif sur port ${PORT}`);
  console.log(`   /send       → Proxy 360dialog`);
  console.log(`   /webhook    → Réception statuts`);
  console.log(`   /statuts    → Statuts courants`);
  console.log(`   /historique → Historique complet`);
});
