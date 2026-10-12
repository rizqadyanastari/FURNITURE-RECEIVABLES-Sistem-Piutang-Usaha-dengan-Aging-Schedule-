const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const SUPABASE_URL = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const FRONTEND_ORIGIN = process.env.FRONTEND_URL?.trim()
  ? new URL(process.env.FRONTEND_URL.trim()).origin
  : null;
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function requireConfig(response) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(response, 503, {
      error: "Backend belum dikonfigurasi. Atur SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY."
    });
    return false;
  }
  return true;
}

async function supabaseRequest(resource, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${resource}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });
  const body = await response.text();
  if (!response.ok) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.message || parsed.details || parsed.hint || body;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const error = new Error(`Supabase menolak permintaan (${response.status}): ${detail}`);
    error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw error;
  }
  return body ? JSON.parse(body) : null;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 16_384) {
        tooLarge = true;
        const error = new Error("Ukuran permintaan terlalu besar.");
        error.statusCode = 413;
        reject(error);
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        const value = JSON.parse(body || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Body JSON harus berupa objek.");
        }
        resolve(value);
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasAtMostTwoDecimals(value) {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}

async function handleApi(request, response, url) {
  if (!requireConfig(response)) return;

  if (request.method === "GET" && url.pathname === "/api/aging") {
    const data = await supabaseRequest("aging_schedule?select=*&order=due_date.asc");
    sendJson(response, 200, { data });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/customers") {
    const data = await supabaseRequest("customers?select=id,name,company_name,email,phone&order=name.asc");
    sendJson(response, 200, { data });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/customers") {
    const customer = await readJson(request);
    const name = typeof customer.name === "string" ? customer.name.trim() : "";
    if (!name || name.length > 160) {
      sendJson(response, 400, { error: "Nama pelanggan wajib diisi (maksimal 160 karakter)." });
      return;
    }
    for (const field of ["company_name", "email", "phone", "address"]) {
      if (customer[field] != null && typeof customer[field] !== "string") {
        sendJson(response, 400, { error: `${field} harus berupa teks.` });
        return;
      }
    }
    const result = await supabaseRequest("customers", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name,
        company_name: customer.company_name?.trim() || null,
        email: customer.email?.trim() || null,
        phone: customer.phone?.trim() || null,
        address: customer.address?.trim() || null
      })
    });
    sendJson(response, 201, { data: result });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/invoices") {
    const invoice = await readJson(request);
    if (typeof invoice.customer_id !== "string" || !/^[0-9a-f-]{36}$/i.test(invoice.customer_id)) {
      sendJson(response, 400, { error: "Pilih pelanggan yang valid." });
      return;
    }
    if (typeof invoice.invoice_number !== "string" || !invoice.invoice_number.trim() || invoice.invoice_number.length > 80) {
      sendJson(response, 400, { error: "Nomor invoice wajib diisi (maksimal 80 karakter)." });
      return;
    }
    if (!isValidDate(invoice.invoice_date) || !isValidDate(invoice.due_date) ||
        invoice.due_date < invoice.invoice_date) {
      sendJson(response, 400, { error: "Tanggal jatuh tempo harus sama atau setelah tanggal invoice." });
      return;
    }
    if (!Array.isArray(invoice.items) || invoice.items.length === 0 || invoice.items.length > 100) {
      sendJson(response, 400, { error: "Invoice harus memiliki 1 sampai 100 item." });
      return;
    }
    const items = [];
    for (const item of invoice.items) {
      const description = typeof item.description === "string" ? item.description.trim() : "";
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      if (!description || description.length > 240 || !Number.isFinite(quantity) || quantity <= 0 ||
          !Number.isFinite(unitPrice) || unitPrice < 0 ||
          !hasAtMostTwoDecimals(quantity) || !hasAtMostTwoDecimals(unitPrice)) {
        sendJson(response, 400, { error: "Periksa deskripsi, kuantitas, dan harga setiap item invoice." });
        return;
      }
      items.push({ description, quantity, unit_price: unitPrice });
    }
    const data = await supabaseRequest("rpc/create_invoice_with_items", {
      method: "POST",
      body: JSON.stringify({
        p_invoice_number: invoice.invoice_number.trim(),
        p_customer_id: invoice.customer_id,
        p_invoice_date: invoice.invoice_date,
        p_due_date: invoice.due_date,
        p_items: items
      })
    });
    sendJson(response, 201, { data });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/payments") {
    const payment = await readJson(request);
    const amount = Number(payment.amount);
    if (typeof payment.invoice_id !== "string" || !/^[0-9a-f-]{36}$/i.test(payment.invoice_id)) {
      sendJson(response, 400, { error: "invoice_id harus berupa UUID yang valid." });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || !hasAtMostTwoDecimals(amount)) {
      sendJson(response, 400, { error: "amount harus lebih besar dari 0 dan maksimal memiliki 2 angka desimal." });
      return;
    }
    if (!isValidDate(payment.payment_date)) {
      sendJson(response, 400, { error: "payment_date harus menggunakan format YYYY-MM-DD." });
      return;
    }
    const result = await supabaseRequest("rpc/record_invoice_payment", {
      method: "POST",
      body: JSON.stringify({
        p_invoice_id: payment.invoice_id,
        p_amount: amount,
        p_payment_date: payment.payment_date,
        p_payment_method: typeof payment.payment_method === "string" ? payment.payment_method : null
      })
    });
    sendJson(response, 201, { data: result });
    return;
  }

  sendJson(response, 404, { error: "Endpoint tidak ditemukan." });
}

function serveFrontend(response, pathname) {
  const requestedFile = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "styles.css", "config.js", "app.js"].includes(requestedFile)) {
    sendJson(response, 404, { error: "Halaman tidak ditemukan." });
    return;
  }
  const filePath = path.join(FRONTEND_DIR, requestedFile);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      console.error(`Gagal membaca file frontend ${requestedFile}:`, error);
      sendJson(response, 500, { error: "File frontend tidak dapat dibaca." });
      return;
    }
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const origin = request.headers.origin;
      if (origin && FRONTEND_ORIGIN && origin !== FRONTEND_ORIGIN) {
        sendJson(response, 403, { error: "Origin tidak diizinkan." });
        return;
      }
      if (origin && FRONTEND_ORIGIN && origin === FRONTEND_ORIGIN) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Metode tidak diizinkan." });
      return;
    }
    serveFrontend(response, url.pathname);
  } catch (error) {
    console.error("Permintaan gagal:", error);
    if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.message });
    else response.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FURNITURE RECEIVABLES berjalan di http://${HOST}:${PORT}`);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Atur SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY agar data Supabase dapat diakses.");
  }
});
