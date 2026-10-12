const STORAGE_KEY = "furniture-receivables-demo-v1";
const currency = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});

const state = { customers: [], invoices: [], filter: "all", search: "" };
const $ = selector => document.querySelector(selector);
const elements = {
  rows: $("#invoice-rows"),
  items: $("#items"),
  customerDialog: $("#customer-dialog"),
  invoiceDialog: $("#invoice-dialog"),
  paymentDialog: $("#payment-dialog"),
  customerForm: $("#customer-form"),
  invoiceForm: $("#invoice-form"),
  paymentForm: $("#payment-form")
};

const agingBuckets = [
  { key: "Current", label: "Belum jatuh tempo" },
  { key: "1-30", label: "1–30 hari" },
  { key: "31-60", label: "31–60 hari" },
  { key: "61-90", label: "61–90 hari" },
  { key: "90+", label: "Lebih dari 90 hari" }
];

function localDate(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function makeDemoData() {
  const customers = [
    { id: crypto.randomUUID(), name: "Budi Santoso", company_name: "PT Ruang Kayu", email: "budi@example.com", phone: "0812-0000-1234" },
    { id: crypto.randomUUID(), name: "Sari Wijaya", company_name: "Kedai Kopi Senja", email: "sari@example.com", phone: "0813-0000-5678" },
    { id: crypto.randomUUID(), name: "Andi Pratama", company_name: "Villa Pinus", email: "andi@example.com", phone: "0815-0000-9012" }
  ];
  const invoices = [
    { id: crypto.randomUUID(), invoice_number: "INV-2026-014", customer_id: customers[0].id, invoice_date: dateOffset(-40), due_date: dateOffset(-10), items: [{ description: "Meja makan jati 6 kursi", quantity: 1, unit_price: 12500000 }], payments: [{ id: crypto.randomUUID(), amount: 2500000, payment_date: dateOffset(-4), payment_method: "Transfer bank" }] },
    { id: crypto.randomUUID(), invoice_number: "INV-2026-015", customer_id: customers[1].id, invoice_date: dateOffset(-18), due_date: dateOffset(12), items: [{ description: "Kursi bar kayu solid", quantity: 8, unit_price: 875000 }], payments: [] },
    { id: crypto.randomUUID(), invoice_number: "INV-2026-016", customer_id: customers[2].id, invoice_date: dateOffset(-72), due_date: dateOffset(-42), items: [{ description: "Lemari pakaian 3 pintu", quantity: 2, unit_price: 8200000 }], payments: [{ id: crypto.randomUUID(), amount: 3000000, payment_date: dateOffset(-20), payment_method: "Transfer bank" }] },
    { id: crypto.randomUUID(), invoice_number: "INV-2026-017", customer_id: customers[0].id, invoice_date: dateOffset(-145), due_date: dateOffset(-115), items: [{ description: "Bufet ruang keluarga", quantity: 1, unit_price: 6400000 }], payments: [] }
  ];
  return { customers, invoices };
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      customers: state.customers,
      invoices: state.invoices
    }));
    return true;
  } catch (error) {
    showNotice(`Data gagal disimpan di browser: ${error.message}`, true);
    return false;
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      Object.assign(state, makeDemoData());
      saveData();
      return;
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.customers) || !Array.isArray(data.invoices)) {
      throw new Error("Format data demo tidak dikenali.");
    }
    state.customers = data.customers;
    state.invoices = data.invoices;
  } catch (error) {
    showNotice(`Data lokal tidak dapat dibaca: ${error.message}. Reset demo untuk memulai ulang.`, true);
    const demo = makeDemoData();
    state.customers = demo.customers;
    state.invoices = demo.invoices;
  }
}

function showNotice(message, isError = false) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
  if (!isError) window.setTimeout(() => { notice.hidden = true; }, 3500);
}

function customerFor(invoice) {
  return state.customers.find(customer => customer.id === invoice.customer_id);
}

function invoiceTotal(invoice) {
  return invoice.items.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_price * 100) / 100, 0);
}

function invoicePaid(invoice) {
  return invoice.payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

function invoiceBalance(invoice) {
  return Math.max(0, invoiceTotal(invoice) - invoicePaid(invoice));
}

function invoiceAging(invoice, today = localDate()) {
  const balance = invoiceBalance(invoice);
  if (balance <= 0) return { key: "Paid", daysLate: 0, daysUntil: 0 };
  const difference = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_date}T00:00:00Z`)) / 86_400_000);
  if (difference <= 0) return { key: "Current", daysLate: 0, daysUntil: -difference };
  if (difference <= 30) return { key: "1-30", daysLate: difference, daysUntil: 0 };
  if (difference <= 60) return { key: "31-60", daysLate: difference, daysUntil: 0 };
  if (difference <= 90) return { key: "61-90", daysLate: difference, daysUntil: 0 };
  return { key: "90+", daysLate: difference, daysUntil: 0 };
}

function formatDate(value) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit", month: "short", year: "numeric"
  }).format(new Date(`${value}T00:00:00`));
}

function renderSummary() {
  const open = state.invoices.filter(invoice => invoiceBalance(invoice) > 0);
  const overdue = open.filter(invoice => invoiceAging(invoice).daysLate > 0);
  const dueSoon = open.filter(invoice => {
    const aging = invoiceAging(invoice);
    return aging.key === "Current" && aging.daysUntil <= 30;
  });
  $("#total-open").textContent = currency.format(open.reduce((sum, invoice) => sum + invoiceBalance(invoice), 0));
  $("#total-overdue").textContent = currency.format(overdue.reduce((sum, invoice) => sum + invoiceBalance(invoice), 0));
  $("#overdue-count").textContent = overdue.length;
  $("#total-due-soon").textContent = currency.format(dueSoon.reduce((sum, invoice) => sum + invoiceBalance(invoice), 0));
  $("#open-count").textContent = open.length;
  $("#invoice-count").textContent = state.invoices.length;
  $("#today").textContent = new Intl.DateTimeFormat("id-ID", {
    weekday: "long", day: "numeric", month: "short", year: "numeric"
  }).format(new Date());
  $("#as-of").textContent = `Per ${new Intl.DateTimeFormat("id-ID", {
    day: "numeric", month: "long", year: "numeric"
  }).format(new Date())}`;

  $("#aging-summary").innerHTML = agingBuckets.map(bucket => {
    const invoices = open.filter(invoice => invoiceAging(invoice).key === bucket.key);
    const amount = invoices.reduce((sum, invoice) => sum + invoiceBalance(invoice), 0);
    const overdueClass = bucket.key === "Current" ? "" : " overdue";
    return `<div class="aging-item${overdueClass}"><p>${bucket.label}</p><strong>${currency.format(amount)}</strong><span class="count">${invoices.length} invoice</span></div>`;
  }).join("");
}

function renderRows() {
  const filtered = state.invoices.filter(invoice => {
    const bucket = invoiceAging(invoice).key;
    const customer = customerFor(invoice);
    const matchesBucket = state.filter === "all" || bucket === state.filter;
    const query = state.search.toLocaleLowerCase("id-ID");
    const matchesSearch = !query || [invoice.invoice_number, customer?.name, customer?.company_name]
      .some(value => String(value || "").toLocaleLowerCase("id-ID").includes(query));
    return matchesBucket && matchesSearch;
  }).sort((a, b) => a.due_date.localeCompare(b.due_date));

  $("#result-count").textContent = `${filtered.length} dari ${state.invoices.length} invoice`;
  if (!filtered.length) {
    elements.rows.innerHTML = `<tr><td colspan="7" class="empty">${state.invoices.length ? "Tidak ada invoice yang sesuai pencarian atau filter." : "Belum ada invoice. Tambahkan pelanggan dan invoice untuk memulai."}</td></tr>`;
    return;
  }
  elements.rows.innerHTML = filtered.map(invoice => {
    const customer = customerFor(invoice);
    const balance = invoiceBalance(invoice);
    const aging = invoiceAging(invoice);
    const paid = balance <= 0;
    const label = paid ? "Lunas" : agingBuckets.find(bucket => bucket.key === aging.key).label;
    const pillClass = paid ? "pill-paid" : `pill-${aging.key.toLowerCase().replace("+", "-plus")}`;
    const age = paid ? "—" : aging.daysLate ? `${aging.daysLate} hari` : "Belum jatuh tempo";
    const paymentButton = paid ? "" : `<button class="pay-button" type="button" data-pay="${escapeHtml(invoice.id)}">Catat bayar</button>`;
    return `<tr>
      <td><span class="invoice-number">${escapeHtml(invoice.invoice_number)}</span><span class="customer-name">${escapeHtml(customer?.name || "Pelanggan dihapus")}${customer?.company_name ? ` · ${escapeHtml(customer.company_name)}` : ""}</span></td>
      <td>${formatDate(invoice.invoice_date)}</td><td>${formatDate(invoice.due_date)}</td><td>${age}</td>
      <td class="amount">${currency.format(balance)}</td><td><span class="pill ${pillClass}">${label}</span></td><td>${paymentButton}</td>
    </tr>`;
  }).join("");
}

function render() {
  renderSummary();
  renderRows();
}

function renderCustomerOptions() {
  $("#invoice-customer").innerHTML = `<option value="">Pilih pelanggan</option>${state.customers
    .slice().sort((a, b) => a.name.localeCompare(b.name, "id"))
    .map(customer => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}${customer.company_name ? ` · ${escapeHtml(customer.company_name)}` : ""}</option>`)
    .join("")}`;
}

function addItemRow() {
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `<input class="item-description" maxlength="200" placeholder="Nama furniture" aria-label="Nama furniture" required>
    <input class="item-quantity" type="number" min="0.01" step="0.01" placeholder="Jumlah" aria-label="Kuantitas" required>
    <input class="item-price" type="number" min="0" step="0.01" placeholder="Harga (Rp)" aria-label="Harga satuan" required>
    <button class="remove-item" type="button" aria-label="Hapus item">×</button>`;
  elements.items.append(row);
  updateInvoiceTotal();
}

function updateInvoiceTotal() {
  const rows = [...elements.items.querySelectorAll(".item-row")];
  const total = rows.reduce((sum, row) => {
    const quantity = Number(row.querySelector(".item-quantity").value) || 0;
    const price = Number(row.querySelector(".item-price").value) || 0;
    return sum + Math.round(quantity * price * 100) / 100;
  }, 0);
  $("#invoice-total").textContent = currency.format(total);
  rows.forEach(row => { row.querySelector(".remove-item").disabled = rows.length === 1; });
}

function openInvoiceDialog() {
  if (!state.customers.length) {
    showNotice("Tambahkan pelanggan terlebih dahulu sebelum membuat invoice.", true);
    return;
  }
  elements.invoiceForm.reset();
  elements.items.replaceChildren();
  $("#invoice-error").hidden = true;
  renderCustomerOptions();
  $("#invoice-date").value = localDate();
  $("#due-date").value = localDate();
  addItemRow();
  elements.invoiceDialog.showModal();
}

function openPaymentDialog(invoice) {
  $("#payment-form").reset();
  $("#payment-error").hidden = true;
  $("#payment-invoice-id").value = invoice.id;
  $("#payment-description").textContent = `${invoice.invoice_number} · Sisa saldo ${currency.format(invoiceBalance(invoice))}`;
  $("#payment-amount").max = invoiceBalance(invoice);
  $("#payment-date").value = localDate();
  elements.paymentDialog.showModal();
}

$("#add-customer").addEventListener("click", () => {
  elements.customerForm.reset();
  $("#customer-error").hidden = true;
  elements.customerDialog.showModal();
});
$("#add-invoice").addEventListener("click", openInvoiceDialog);
$("#add-item").addEventListener("click", addItemRow);
elements.items.addEventListener("input", updateInvoiceTotal);
elements.items.addEventListener("click", event => {
  const button = event.target.closest(".remove-item");
  if (!button || elements.items.querySelectorAll(".item-row").length <= 1) return;
  button.closest(".item-row").remove();
  updateInvoiceTotal();
});
document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
$("#filters").addEventListener("click", event => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach(filter => filter.classList.toggle("selected", filter === button));
  renderRows();
});
$("#search").addEventListener("input", event => {
  state.search = event.target.value;
  renderRows();
});
elements.rows.addEventListener("click", event => {
  const button = event.target.closest("[data-pay]");
  if (!button) return;
  const invoice = state.invoices.find(item => item.id === button.dataset.pay);
  if (invoice) openPaymentDialog(invoice);
});

elements.customerForm.addEventListener("submit", event => {
  event.preventDefault();
  const form = new FormData(elements.customerForm);
  const name = String(form.get("name") || "").trim();
  state.customers.push({
    id: crypto.randomUUID(),
    name,
    company_name: String(form.get("company_name") || "").trim(),
    email: String(form.get("email") || "").trim(),
    phone: String(form.get("phone") || "").trim()
  });
  if (!saveData()) {
    state.customers.pop();
    return;
  }
  elements.customerDialog.close();
  render();
  showNotice("Pelanggan berhasil disimpan di browser ini.");
});

elements.invoiceForm.addEventListener("submit", event => {
  event.preventDefault();
  const error = $("#invoice-error");
  error.hidden = true;
  const invoiceDate = $("#invoice-date").value;
  const dueDate = $("#due-date").value;
  const items = [...elements.items.querySelectorAll(".item-row")].map(row => ({
    description: row.querySelector(".item-description").value.trim(),
    quantity: Number(row.querySelector(".item-quantity").value),
    unit_price: Number(row.querySelector(".item-price").value)
  }));
  const total = items.reduce((sum, item) => sum + Math.round(item.quantity * item.unit_price * 100) / 100, 0);
  if (dueDate < invoiceDate || items.some(item => !item.description || !Number.isFinite(item.quantity) ||
      item.quantity <= 0 || !Number.isFinite(item.unit_price) || item.unit_price < 0) || total <= 0) {
    error.textContent = "Periksa tanggal dan semua rincian item. Total invoice harus lebih dari Rp0.";
    error.hidden = false;
    return;
  }
  const number = $("#invoice-number").value.trim();
  if (state.invoices.some(invoice => invoice.invoice_number.toLocaleLowerCase("id-ID") === number.toLocaleLowerCase("id-ID"))) {
    error.textContent = "Nomor invoice sudah digunakan. Gunakan nomor yang berbeda.";
    error.hidden = false;
    return;
  }
  const invoice = {
    id: crypto.randomUUID(),
    invoice_number: number,
    customer_id: $("#invoice-customer").value,
    invoice_date: invoiceDate,
    due_date: dueDate,
    items,
    payments: []
  };
  state.invoices.push(invoice);
  if (!saveData()) {
    state.invoices.pop();
    return;
  }
  elements.invoiceDialog.close();
  render();
  showNotice("Invoice berhasil disimpan di browser ini.");
});

elements.paymentForm.addEventListener("submit", event => {
  event.preventDefault();
  const invoice = state.invoices.find(item => item.id === $("#payment-invoice-id").value);
  const amount = Number($("#payment-amount").value);
  const error = $("#payment-error");
  if (!invoice || !Number.isFinite(amount) || amount <= 0 || amount > invoiceBalance(invoice)) {
    error.textContent = "Pembayaran harus lebih dari Rp0 dan tidak boleh melebihi sisa saldo.";
    error.hidden = false;
    return;
  }
  invoice.payments.push({
    id: crypto.randomUUID(),
    amount,
    payment_date: $("#payment-date").value,
    payment_method: $("#payment-method").value
  });
  if (!saveData()) {
    invoice.payments.pop();
    return;
  }
  elements.paymentDialog.close();
  render();
  showNotice("Pembayaran berhasil dicatat di browser ini.");
});

$("#reset-demo").addEventListener("click", () => {
  if (!window.confirm("Hapus perubahan lokal dan kembalikan data demo awal?")) return;
  localStorage.removeItem(STORAGE_KEY);
  state.filter = "all";
  state.search = "";
  $("#search").value = "";
  loadData();
  render();
  showNotice("Data demo berhasil direset.");
});

loadData();
render();
