// 配筋黒板 PoC: 符号を選んで撮影し、写真と黒板の情報を1つの記録として端末に保存する。
"use strict";

const FLOORS = ["1F", "2F", "3F", "4F", "5F", "6F", "7F", "8F", "RF"];
const TYPES = ["柱", "大梁", "小梁", "スラブ", "壁"];
const CORNERS = ["左上", "右上", "左下", "右下"];   // 写真に入れる黒板の位置
const $ = (id) => document.getElementById(id);
const state = { data: null, floor: null, type: null, board: null, item: null, sub: null, corner: "左下" };
// 写真の記録に使う検査項目名(細分があれば「構造スリット（水平スリット）」の形)
const itemLabel = (b) => b.label ?? b.item;

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
const deleteRecord = (id) => tx("readwrite", (s) => s.delete(id));
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

// ---------- 枝番 ----------
// 同じ階・同じ黒板(符号＋検査項目)の写真に 1, 2, 3… と番号を振る。1枚目は表示しない。
async function nextBranch(floor, boardId, exceptId) {
  const same = (await allRecords()).filter((r) => r.floor === floor && r.board_id === boardId && r.photo_id !== exceptId);
  return same.reduce((m, r) => Math.max(m, r.branch ?? 1), 0) + 1;
}
const symbolWithBranch = (r) => (r.branch > 1 ? `${r.symbol}-${r.branch}` : r.symbol);

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
  // 符号・検査項目・細分を選び直したら、今の選択に最も近い黒板を選ぶ
  const pick = (sym, item, sub) =>
    list.find((b) => b.symbol === sym && b.item === item && (b.sub ?? null) === sub) ??
    list.find((b) => b.symbol === sym && b.item === item) ??
    list.find((b) => b.symbol === sym);
  const setBoard = (b) => { state.board = b; state.item = b.item; state.sub = b.sub ?? null; };
  chips($("symbols"), symbols, state.board?.symbol, null, (sym) => {
    const prev = state.board;
    setBoard(pick(sym, state.item, state.sub));
    if (prev && prev.symbol !== sym) toast(`符号を変更しました: ${prev.symbol} → ${sym}`);
    render();
  });
  const mine = state.board ? list.filter((b) => b.symbol === state.board.symbol) : [];
  const items = [...new Set(mine.map((b) => b.item))];
  chips($("items"), items, state.item, null, (v) => { setBoard(pick(state.board.symbol, v, state.sub)); render(); });
  const subs = mine.filter((b) => b.item === state.item && b.sub).map((b) => b.sub);
  $("subsBox").hidden = !subs.length;
  chips($("subs"), subs, state.sub, null, (v) => { setBoard(pick(state.board.symbol, state.item, v)); render(); });

  // 開くたびに左下から始める(基本は左下)
  chips($("corners"), CORNERS, state.corner, null, (v) => { state.corner = v; render(); });

  const ready = state.floor && state.board;
  $("selected").hidden = !ready;
  $("camera").disabled = !ready;
  $("shootLabel").className = ready ? "" : "off";
  $("shootLabel").textContent = ready ? `撮影する（${state.floor} ${state.board.symbol} ${itemLabel(state.board)}）` : "符号を選んでください";
  if (ready) {
    const lines = boardLines(state.board, state.floor);
    $("selected").innerHTML =
      `<div class="big">${state.floor}　${esc(state.board.symbol)}</div>` +
      `<div>${esc(state.board.type)}・${esc(itemLabel(state.board))}</div>` +
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
  const rec = {
    photo_id: crypto.randomUUID(),
    project_id: state.data.project.id,
    floor, type: board.type, symbol: board.symbol, item: itemLabel(board),
    board_id: board.board_id,
    branch: await nextBranch(floor, board.board_id),
    board_lines: lines,
    captured_at_device: localIso(now),
    board_corner: state.corner,
    exif_datetime: readExifDate(buf),
    sha256: sha,
    original: new Blob([buf], { type: file.type || "image/jpeg" }),
    sync_state: "未書き出し",
    history: [],
  };
  rec.composed = await composeImage(file, rec);
  await putRecord(rec);
  toast(`保存しました: ${floor} ${symbolWithBranch(rec)} ${rec.item}`);
  updateCount();
}

// 写真の黒板は最小限(工事名・階と部材の配筋・符号・撮影日)。配筋の詳細は台帳の右側に載せる。
function photoBoardRows(r) {
  return [state.data.project.name, r.board_lines[0], r.symbol, fmtDate(new Date(r.captured_at_device))];
}

async function composeImage(file, r) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  const rows = photoBoardRows(r);
  const bw = Math.round(w * 0.3), size = Math.max(14, Math.floor(bw / 16));
  const pad = size / 2, lh = Math.round(size * 1.45), bh = pad * 2 + lh * rows.length;
  const m = Math.round(w / 50), corner = r.board_corner ?? "左下";
  const x = corner.startsWith("左") ? m : w - bw - m;
  const y = corner.endsWith("上") ? m : h - bh - m;
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
    div.innerHTML = `<img src="${url}"><div class="meta"><b>${esc(r.floor)} ${esc(symbolWithBranch(r))}</b> ${esc(r.type)}・${esc(r.item)}<br>` +
      `${r.captured_at_device.replace("T", " ").slice(0, 16)}<br>${r.sync_state}` +
      (r.history.length ? `<br>修正 ${r.history.length}回` : "") + `<br><button>大きく見る</button></div>`;
    div.querySelector("img").onclick = div.querySelector("button").onclick = () => openViewer(r);
    return div;
  }));
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $("storageInfo").textContent = est
    ? `端末内の使用量: ${(est.usage / 1e6).toFixed(1)}MB / 上限の目安 ${(est.quota / 1e6).toFixed(0)}MB　保護: ${persisted ? "あり" : "なし"}`
    : "";
}

// ---------- 写真の確認(拡大)・削除 ----------
let viewing = null;
function openViewer(r) {
  viewing = r;
  $("viewerTitle").textContent = `${r.floor} ${symbolWithBranch(r)} ${r.item}`;
  showViewerImage("composed");
  renderViewerCorners();
  $("viewer").hidden = false;
}
function showViewerImage(kind) {
  URL.revokeObjectURL($("viewerImg").src);
  $("viewerImg").src = URL.createObjectURL(viewing[kind]);
  $("viewerKind").textContent = kind === "composed" ? "元の写真を見る" : "黒板入りを見る";
  $("viewerKind").onclick = () => showViewerImage(kind === "composed" ? "original" : "composed");
}
// 撮った後でも黒板の位置を変えられる(元の写真から作り直す)
function renderViewerCorners() {
  chips($("viewerCorners"), CORNERS, viewing.board_corner ?? "左下", null, async (v) => {
    viewing.board_corner = v;
    viewing.composed = await composeImage(viewing.original, viewing);
    viewing.sync_state = "未書き出し";
    await putRecord(viewing);
    showViewerImage("composed");
    renderViewerCorners();
    renderList();
    toast(`黒板を${v}に移しました。`);
  });
}
function closeViewer() {
  $("viewer").hidden = true;
  URL.revokeObjectURL($("viewerImg").src);
  viewing = null;
}
async function deleteViewing() {
  const r = viewing;
  const note = r.sync_state === "書き出し済" ? "\n書き出し済みのファイル(iPhoneの「ファイル」やPC)は消えません。" : "";
  if (!confirm(`「${r.floor} ${symbolWithBranch(r)} ${r.item}」の写真を削除しますか？\n元に戻せません。${note}`)) return;
  await deleteRecord(r.photo_id);
  closeViewer();
  toast("削除しました。");
  renderList();
  updateCount();
}

async function reassign(r) {
  if (!state.board || !state.floor) { toast("先に「撮影」画面で、正しい階と符号を選んでください。"); return; }
  const to = `${state.floor} ${state.board.symbol} ${itemLabel(state.board)}`;
  if (!confirm(`この写真を「${r.floor} ${r.symbol} ${r.item}」から「${to}」に直しますか？`)) return;
  const lines = boardLines(state.board, state.floor);
  r.history.push({ at: localIso(new Date()), from: { floor: r.floor, board_id: r.board_id, branch: r.branch }, to: { floor: state.floor, board_id: state.board.board_id } });
  Object.assign(r, { floor: state.floor, type: state.board.type, symbol: state.board.symbol, item: itemLabel(state.board),
    board_id: state.board.board_id, board_lines: lines, sync_state: "未書き出し",
    branch: await nextBranch(state.floor, state.board.board_id, r.photo_id) });
  r.composed = await composeImage(r.original, r);
  await putRecord(r);
  closeViewer();
  toast(`直しました: ${state.floor} ${symbolWithBranch(r)} ${r.item}`);
  renderList();
}

// all=false: まだ書き出していない写真だけ / all=true: 端末にある写真すべて(書き出し直し)
async function exportRecords(all) {
  const recs = (await allRecords()).filter((r) => all || r.sync_state !== "書き出し済");
  if (!recs.length) { toast(all ? "写真がありません。" : "書き出していない写真はありません。「すべて書き出す」で書き出し直せます。"); return; }
  // ファイル名で中身がわかるように「階_符号-枝番_検査項目_IDの先頭」にする
  const base = (r) => `${r.floor}_${symbolWithBranch(r)}_${r.item}_${r.photo_id.slice(0, 8)}`.replace(/[\\/:*?"<>|]/g, "_");
  const meta = recs.map(({ original, composed, ...m }) => ({ ...m, file: `${base(m)}.jpg`, original_file: `${base(m)}_元.jpg` }));
  const stamp = localIso(new Date()).replace(/[-:T]/g, "").slice(0, 14);
  const files = [new File([JSON.stringify(meta, null, 1)], `records_${stamp}.json`, { type: "application/json" })];
  recs.forEach((r, i) => {
    files.push(new File([r.composed], meta[i].file, { type: "image/jpeg" }));
    files.push(new File([r.original], meta[i].original_file, { type: r.original.type }));
  });
  if (!navigator.canShare?.({ files })) { toast("この端末では共有での書き出しができません。"); return; }
  try {
    await navigator.share({ files });   // title を付けるとiPhoneでは余分なテキストファイルとして保存される
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
  $("exportBtn").onclick = () => exportRecords(false);
  $("exportAllBtn").onclick = () => exportRecords(true);
  $("viewerClose").onclick = closeViewer;
  $("viewerDelete").onclick = deleteViewing;
  $("viewerReassign").onclick = () => reassign(viewing);
  const saved = await getSetting("boards");
  if (saved) applyBoards(saved); else render();
  updateCount();
})();
