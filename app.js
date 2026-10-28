// 配筋黒板 PoC: 符号を選んで撮影し、写真と黒板の情報を1つの記録として端末に保存する。
"use strict";

const FLOORS = ["1F", "2F", "3F", "4F", "5F", "6F", "7F", "8F", "RF"];
const TYPES = ["柱", "大梁", "小梁", "スラブ", "壁"];
const $ = (id) => document.getElementById(id);
const state = { data: null, floor: null, type: null, board: null, item: null };

// ---------- 端末内の保存(IndexedDB) ----------
let dbp;
function db() {
  dbp ??= new Promise((ok, ng) => {
    const r = indexedDB.open("haikin", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("photos")) {
        const s = d.createObjectStore("photos", { keyPath: "photo_id" });
        s.createIndex("sha256", "sha256", { unique: true });
      }
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
  return dbp;
}
async function tx(mode, fn, store = "photos") {
  const d = await db();
  return new Promise((ok, ng) => {
    const t = d.transaction(store, mode);
    const res = fn(t.objectStore(store));
    t.oncomplete = () => ok(res instanceof IDBRequest ? res.result : res);
    t.onerror = () => ng(t.error);
  });
}
const putRecord = (rec) => tx("readwrite", (s) => s.put(rec));
const allRecords = () => tx("readonly", (s) => s.getAll());
const findBySha = (sha) => tx("readonly", (s) => s.index("sha256").get(sha));
const getSetting = (key) => tx("readonly", (s) => s.get(key), "settings");
const putSetting = (key, value) => tx("readwrite", (s) => s.put(value, key), "settings");

// ---------- 黒板データの読み込み ----------
// 工事名や配筋はサイトに置かず、PCで作った boards.json を端末で読み込んで保存する。
async function importBoards(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("読み込めませんでした。boards.json を選んでください。"); return;
  }
  if (!data?.project?.name || !Array.isArray(data.boards)) { toast("黒板データの形ではありません。boards.json を選んでください。"); return; }
  await putSetting("boards", data);
  applyBoards(data);
  toast(`黒板データを読み込みました: ${data.boards.length}件`);
}
function applyBoards(data) {
  state.data = data;
  state.board = null;
  $("title").textContent = data.project.name.replace("共同住宅新築工事", "");
  $("noData").hidden = true;
  $("pickers").hidden = false;
  render();
}

// ---------- 黒板の文字 ----------
function boardLines(board, floor) {
  return board.lines.map((s) => s.replace("{階}", floor));
}
function boardsFor(floor, type) {
  return state.data.boards.filter((b) => b.type === type && (b.floor === null || b.floor === floor));
}

// ---------- 画面: 選択 ----------
function chips(el, values, current, label, onPick) {
  el.replaceChildren(...values.map((v) => {
    const b = document.createElement("button");
    b.textContent = label ? label(v) : v;
    b.className = v === current ? "on" : "";
    b.onclick = () => onPick(v);
    return b;
  }));
}

function render() {
  chips($("floors"), FLOORS, state.floor, null, (v) => { state.floor = v; state.board = null; render(); });
  chips($("types"), TYPES, state.type, null, (v) => { state.type = v; state.board = null; render(); });
  const list = state.data && state.floor && state.type ? boardsFor(state.floor, state.type) : [];
  const symbols = [...new Set(list.map((b) => b.symbol))];
  chips($("symbols"), symbols, state.board?.symbol, null, (sym) => {
    const prev = state.board;
    state.board = list.find((b) => b.symbol === sym && b.item === (state.item ?? b.item)) ?? list.find((b) => b.symbol === sym);
    state.item = state.board.item;
    if (prev && prev.symbol !== sym) toast(`符号を変更しました: ${prev.symbol} → ${sym}`);
    render();
  });
  const items = state.board ? [...new Set(list.filter((b) => b.symbol === state.board.symbol).map((b) => b.item))] : [];
  chips($("items"), items, state.item, null, (v) => {
    state.item = v;
    state.board = list.find((b) => b.symbol === state.board.symbol && b.item === v);
    render();
  });

  const ready = state.floor && state.board;
  $("selected").hidden = !ready;
  $("camera").disabled = !ready;
  $("shootLabel").className = ready ? "" : "off";
  $("shootLabel").textContent = ready ? `撮影する（${state.floor} ${state.board.symbol} ${state.item}）` : "符号を選んでください";
  if (ready) {
    const lines = boardLines(state.board, state.floor);
    $("selected").innerHTML =
      `<div class="big">${state.floor}　${esc(state.board.symbol)}</div>` +
      `<div>${esc(state.board.type)}・${esc(state.item)}</div>` +
      (state.board.confirmed ? "" : `<div class="warn">未確認のデータです（PoC用）</div>`) +
      `<ol>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ol>`;
  }
}

// ---------- 撮影 → 保存 ----------
async function onPhoto(file) {
  if (!file) return;
  const board = state.board, floor = state.floor;   // 撮影ボタンを押した時点の選択を固定する
  const buf = await file.arrayBuffer();
  const sha = await sha256(buf);
  if (await findBySha(sha)) { toast("同じ写真がすでに保存されています。保存しませんでした。"); return; }
  const lines = boardLines(board, floor);
  const now = new Date();
  const composed = await composeImage(file, lines, now);
  const rec = {
    photo_id: crypto.randomUUID(),
    project_id: state.data.project.id,
    floor, type: board.type, symbol: board.symbol, item: board.item,
    board_id: board.board_id,
    board_lines: lines,
    captured_at_device: localIso(now),
    exif_datetime: readExifDate(buf),
    sha256: sha,
    original: new Blob([buf], { type: file.type || "image/jpeg" }),
    composed,
    sync_state: "未書き出し",
    history: [],
  };
  await putRecord(rec);
  toast(`保存しました: ${floor} ${board.symbol} ${board.item}`);
  updateCount();
}

async function composeImage(file, lines, when) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  const rows = [state.data.project.name, ...lines, fmtDate(when)];
  const bw = Math.round(w * 0.3), size = Math.max(14, Math.floor(bw / 16));
  const pad = size / 2, lh = Math.round(size * 1.45), bh = pad * 2 + lh * rows.length;
  const x = Math.round(w / 50), y = h - bh - Math.round(w / 50);
  g.fillStyle = "#18482f"; g.fillRect(x, y, bw, bh);
  g.strokeStyle = "#f0f0f0"; g.lineWidth = Math.max(2, size / 8); g.strokeRect(x, y, bw, bh);
  g.fillStyle = "#fafafa"; g.font = `${size}px "Hiragino Sans", "BIZ UDGothic", sans-serif`; g.textBaseline = "top";
  rows.forEach((t, i) => g.fillText(t, x + pad, y + pad + i * lh, bw - pad * 2));
  return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
}

// ---------- 一覧・符号の修正・書き出し ----------
async function renderList() {
  const recs = (await allRecords()).sort((a, b) => b.captured_at_device.localeCompare(a.captured_at_device));
  $("records").replaceChildren(...recs.map((r) => {
    const div = document.createElement("div");
    div.className = "rec";
    const url = URL.createObjectURL(r.composed);
    div.innerHTML = `<img src="${url}"><div class="meta"><b>${esc(r.floor)} ${esc(r.symbol)}</b> ${esc(r.type)}・${esc(r.item)}<br>` +
      `${r.captured_at_device.replace("T", " ").slice(0, 16)}<br>${r.sync_state}` +
      (r.history.length ? `<br>修正 ${r.history.length}回` : "") + `<br><button>この写真の符号を直す</button></div>`;
    div.querySelector("button").onclick = () => reassign(r);
    return div;
  }));
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $("storageInfo").textContent = est
    ? `端末内の使用量: ${(est.usage / 1e6).toFixed(1)}MB / 上限の目安 ${(est.quota / 1e6).toFixed(0)}MB　保護: ${persisted ? "あり" : "なし"}`
    : "";
}

async function reassign(r) {
  if (!state.board || !state.floor) { toast("先に「撮影」画面で、正しい階と符号を選んでください。"); return; }
  const to = `${state.floor} ${state.board.symbol} ${state.board.item}`;
  if (!confirm(`この写真を「${r.floor} ${r.symbol} ${r.item}」から「${to}」に直しますか？`)) return;
  const lines = boardLines(state.board, state.floor);
  r.history.push({ at: localIso(new Date()), from: { floor: r.floor, board_id: r.board_id }, to: { floor: state.floor, board_id: state.board.board_id } });
  Object.assign(r, { floor: state.floor, type: state.board.type, symbol: state.board.symbol, item: state.board.item,
    board_id: state.board.board_id, board_lines: lines, sync_state: "未書き出し" });
  r.composed = await composeImage(r.original, lines, new Date(r.captured_at_device));
  await putRecord(r);
  toast(`直しました: ${to}`);
  renderList();
}

async function exportUnsent() {
  const recs = (await allRecords()).filter((r) => r.sync_state !== "書き出し済");
  if (!recs.length) { toast("書き出していない写真はありません。"); return; }
  const meta = recs.map(({ original, composed, ...m }) => ({ ...m, file: `${m.photo_id}.jpg`, original_file: `${m.photo_id}_orig.jpg` }));
  const stamp = localIso(new Date()).replace(/[-:T]/g, "").slice(0, 14);
  const files = [new File([JSON.stringify(meta, null, 1)], `records_${stamp}.json`, { type: "application/json" })];
  for (const r of recs) {
    files.push(new File([r.composed], `${r.photo_id}.jpg`, { type: "image/jpeg" }));
    files.push(new File([r.original], `${r.photo_id}_orig.jpg`, { type: r.original.type }));
  }
  if (!navigator.canShare?.({ files })) { toast("この端末では共有での書き出しができません。"); return; }
  try {
    await navigator.share({ files, title: "配筋写真" });
  } catch (e) {
    toast("書き出しを中止しました。写真は端末に残っています。");
    return;
  }
  for (const r of recs) { r.sync_state = "書き出し済"; await putRecord(r); }
  toast(`${recs.length}枚を書き出しました。`);
  renderList();
}

// ---------- 小さな道具 ----------
async function sha256(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// JPEGのEXIFから撮影日時(DateTimeOriginal)を読む。なければ null。
function readExifDate(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 < v.byteLength) {
    const marker = v.getUint16(p), len = v.getUint16(p + 2);
    if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) {
      const t = p + 10, le = v.getUint16(t) === 0x4949;
      const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
      const findTag = (ifd, tag) => {
        const n = u16(ifd);
        for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; }
        return null;
      };
      const ifd0 = u32(4), exifPtr = findTag(ifd0, 0x8769);
      if (exifPtr === null) return null;
      const e = findTag(u32(exifPtr + 8), 0x9003);
      if (e === null) return null;
      const off = u32(e + 8);
      return String.fromCharCode(...new Uint8Array(buf, t + off, 19));
    }
    p += 2 + len;
  }
  return null;
}
const pad2 = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const fmtDate = (d) => `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.style.display = "none"), 3500);
}
async function updateCount() { $("count").textContent = (await allRecords()).length; }

function show(view) {
  $("shootView").hidden = view !== "shoot";
  $("listView").hidden = view !== "list";
  $("shootBar").hidden = view !== "shoot";
  if (view === "list") renderList();
}

// ---------- 起動 ----------
(async function main() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  navigator.storage?.persist?.();
  $("boardsFile").onchange = (e) => { importBoards(e.target.files[0]); e.target.value = ""; };
  $("boardsFile2").onchange = $("boardsFile").onchange;
  $("camera").onchange = (e) => { onPhoto(e.target.files[0]); e.target.value = ""; };
  $("tabShoot").onclick = () => show("shoot");
  $("tabList").onclick = () => show("list");
  $("exportBtn").onclick = exportUnsent;
  const saved = await getSetting("boards");
  if (saved) applyBoards(saved); else render();
  updateCount();
})();
