import { Engine, FAMILIES } from "./engine.js";

const $ = (s) => document.querySelector(s);
const engine = new Engine(async (f) => new Uint8Array(await (await fetch("fonts/" + f)).arrayBuffer()));

// Limites de défense en profondeur pour éviter les allocations accidentelles excessives.
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_RENDER_PIXELS = 16_000_000;
const WARN_PDF_BYTES = 80 * 1024 * 1024;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

const S = {
  page: 0, count: 0, zoom: 1, tool: "select", name: "document",
  size: null, model: null, sel: null, ed: null,
  undo: [], redo: [], stateId: 0, savedStateId: 0, stateSeq: 0, busy: false, docToken: 0,
  info: null, metadata: null, widgets: [], pageMeta: null, exportMode: "fidelity",
  openSections: new Set(["meta", "pages", "export"]),
};
const ov = $("#ov"), cv = $("#cv"), panel = $("#panel"), pageList = $("#pageList");

function setBusy(on, message = "") {
  S.busy = on;
  document.body.classList.toggle("busy", on);
  document.body.setAttribute("aria-busy", String(on));
  if (message) $("#toolStatus").textContent = message;
  updateChrome();
}

function hasUnsavedChanges() { return S.count > 0 && S.stateId !== S.savedStateId; }

function validatePdfBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new Error("Le fichier est vide ou trop court pour être un PDF valide.");
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!head.includes("%PDF-")) throw new Error("Le fichier ne contient pas d’en-tête PDF reconnaissable.");
}

function safeRenderScale(size, requested) {
  const area = Math.max(1, size.w * size.h);
  const maxByPixels = Math.sqrt(MAX_RENDER_PIXELS / area);
  const maxBySide = 10000 / Math.max(size.w, size.h);
  return Math.max(0.0001, Math.min(requested, maxByPixels, maxBySide));
}

function cleanBaseName(name) {
  return String(name || "document")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ").trim().slice(0, 100) || "document";
}

function trimHistory() {
  let trimmed = false;
  const bytesUsed = () => [...S.undo, ...S.redo].reduce((n, entry) => n + entry.bytes.byteLength, 0);
  while (bytesUsed() > MAX_HISTORY_BYTES) {
    if (S.undo.length > 1) S.undo.shift();
    else if (S.redo.length > 1) S.redo.shift();
    else if (S.redo.length) S.redo.shift();
    else if (S.undo.length) S.undo.shift();
    else break;
    trimmed = true;
  }
  return trimmed;
}

// ---------- utilitaires ----------
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3600);
}
const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " Mio" : Math.max(1, Math.round(n / 1024)) + " Kio";
const pdfVersion = (v) => { const s = String(v || ""); return s.length > 1 ? `${s.slice(0, -1)}.${s.slice(-1)}` : s ? `1.${s}` : "—"; };
const pdfDate = (value) => {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(String(value || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4] || "00"}:${m[5] || "00"}` : (value || "—");
};

function downloadBytes(bytes, filename) {
  const href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = href; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

function askPassword(message) {
  return new Promise((resolve) => {
    const dlg = $("#pwdlg");
    $("#pwmsg").textContent = message;
    $("#pwin").value = "";
    dlg.returnValue = "";
    dlg.onclose = () => { dlg.onclose = null; resolve(dlg.returnValue === "ok" ? $("#pwin").value : null); };
    dlg.showModal();
    setTimeout(() => $("#pwin").focus(), 30);
  });
}

async function toUsableImage(file) {
  if (!file || file.size > MAX_IMAGE_BYTES) throw new Error("Image trop volumineuse (limite : 40 Mio).");
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width: w, height: h } = bmp;
    if (!w || !h || w * h > MAX_IMAGE_PIXELS) throw new Error("Image trop grande pour être traitée sans risque.");
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Impossible de préparer cette image.");
    ctx.drawImage(bmp, 0, 0);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Le navigateur n’a pas pu convertir cette image.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  } finally {
    bmp?.close();
  }
}
const pickFile = (input) => new Promise((res) => {
  input.value = "";
  input.onchange = () => { input.onchange = null; res(input.files[0] || null); };
  input.click();
});

async function pickPdfBytes() {
  const f = await pickFile($("#fpdf"));
  if (!f) return null;
  if (f.size > MAX_PDF_BYTES) { toast("PDF trop volumineux (limite : 200 Mio)."); return null; }
  const bytes = new Uint8Array(await f.arrayBuffer());
  validatePdfBytes(bytes);
  return bytes;
}

function updateThumbActive() {
  pageList.querySelectorAll(".page-thumb").forEach((el, i) => el.classList.toggle("active", i === S.page));
  const active = pageList.querySelector(".page-thumb.active");
  if (active) {
    const top = active.offsetTop, bottom = top + active.offsetHeight;
    if (top < pageList.scrollTop) pageList.scrollTop = top - 8;
    else if (bottom > pageList.scrollTop + pageList.clientHeight) pageList.scrollTop = bottom - pageList.clientHeight + 8;
  }
}

async function renderThumbnails() {
  if (!S.count) return;
  const token = S.docToken;
  pageList.innerHTML = "";
  for (let i = 0; i < S.count; i++) {
    if (token !== S.docToken) return;
    const size = engine.pageSize(i), scale = safeRenderScale(size, Math.min(0.22, 108 / size.w, 152 / size.h));
    const r = engine.render(i, scale), b = document.createElement("button");
    b.type = "button"; b.className = "page-thumb"; b.title = `Aller à la page ${i + 1}`;
    const thumb = document.createElement("canvas"); thumb.width = r.width; thumb.height = r.height;
    thumb.getContext("2d").putImageData(new ImageData(r.pixels, r.width, r.height), 0, 0);
    b.append(thumb);
    b.insertAdjacentHTML("beforeend", `<div class="thumb-meta"><span>Page ${i + 1}</span><span>${Math.round(size.w)} × ${Math.round(size.h)}</span></div>`);
    b.onclick = () => { if (S.busy) return; S.page = i; S.sel = null; refresh(); };
    pageList.append(b);
    if (i % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  $("#pagecount").textContent = `${S.count} ${S.count > 1 ? "pages" : "page"}`;
  updateThumbActive();
}

// ---------- ouverture / enregistrement ----------
async function openBytes(bytes, name) {
  setBusy(true, "Vérification et ouverture du PDF…");
  try {
    validatePdfBytes(bytes);
    let count = 0, password = null;
    for (;;) {
      try { count = engine.open(bytes, password); break; }
      catch (e) {
        if (e.code !== "PASSWORD_REQUIRED" && e.code !== "PASSWORD_INVALID") throw e;
        setBusy(false);
        const pwd = await askPassword(e.code === "PASSWORD_INVALID"
          ? "Mot de passe incorrect. Réessayez."
          : "Ce PDF est protégé. Saisissez le mot de passe pour l’ouvrir. Il reste sur cet appareil.");
        if (pwd == null) throw new Error("Ouverture annulée : un mot de passe est requis.");
        password = pwd;
        setBusy(true, "Déverrouillage du PDF…");
      }
    }
    if (!Number.isInteger(count) || count < 1) throw new Error("Ce PDF ne contient aucune page lisible.");
    S.count = count; S.docToken++;
    S.name = cleanBaseName(name); S.page = 0; S.undo = []; S.redo = []; S.sel = null; S.ed = null;
    S.stateId = ++S.stateSeq; S.savedStateId = S.stateId;
    S.info = null; S.metadata = null; S.widgets = []; S.pageMeta = null;
    $("#empty").style.display = "none"; $("#pagewrap").style.display = "block";
    $("#docName").textContent = `${S.name}.pdf`;
    $("#docMeta").textContent = `${S.count} ${S.count > 1 ? "pages" : "page"} · fichier local`;
    const size = engine.pageSize(0);
    S.zoom = Math.min(1.6, Math.max(0.3, safeRenderScale(size, ($("#stage").clientWidth - 40) / size.w)));
    await renderThumbnails();
    await refresh();
    $("#toolStatus").textContent = "Document prêt à modifier";
  } catch (e) {
    console.error("PDF open failed", e);
    toast(e?.message || "Impossible d’ouvrir ce PDF. Il peut être endommagé, chiffré ou non pris en charge.");
  } finally {
    setBusy(false);
  }
}
async function handlePdfFile(f) {
  if (!f || S.busy) return;
  if (f.size > MAX_PDF_BYTES) return toast("PDF trop volumineux (limite de cette version : 200 Mio).");
  if (f.size > WARN_PDF_BYTES && !confirm("Ce PDF est volumineux et peut ralentir les appareils avec peu de mémoire. Continuer ?")) return;
  if (hasUnsavedChanges() && !confirm("Les modifications non enregistrées seront perdues. Continuer ?")) return;
  setBusy(true, "Lecture du fichier…");
  try { await openBytes(new Uint8Array(await f.arrayBuffer()), f.name); }
  catch (e) { console.error("File read failed", e); toast("Impossible de lire ce fichier sur cet appareil."); }
  finally { setBusy(false); }
}
$("#open").onclick = $("#open2").onclick = async () => handlePdfFile(await pickFile($("#fpdf")));
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault(); const f = e.dataTransfer.files[0];
  if (f) await handlePdfFile(f);
});
const dropzone = $("#dropzone");
dropzone.addEventListener("dragenter", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", async (e) => {
  e.preventDefault(); e.stopPropagation(); dropzone.classList.remove("dragover");
  const f = e.dataTransfer.files[0];
  if (f && (/\.pdf$/i.test(f.name) || f.type === "application/pdf")) await handlePdfFile(f);
  else toast("Déposez un fichier PDF pour commencer.");
});

$("#save").onclick = async () => {
  if (!S.count || S.busy) return;
  setBusy(true, "Préparation du PDF exporté…");
  try {
    const mode = S.exportMode === "compact" ? "compact" : "fidelity";
    const out = engine.save(mode);
    if (!(out instanceof Uint8Array) || !out.length) throw new Error("Le moteur n’a retourné aucun contenu PDF.");
    downloadBytes(out, `${cleanBaseName(S.name)}${mode === "compact" ? "-compact" : "-modifie"}.pdf`);
    S.savedStateId = S.stateId;
    toast(`PDF exporté (${mode === "compact" ? "compact" : "fidélité intégrale"}) · ${fmtSize(out.length)}.`);
  } catch (e) {
    console.error("PDF export failed", e);
    toast("L’export a échoué. Vérifiez l’espace mémoire disponible puis réessayez.");
  } finally {
    setBusy(false);
  }
};

// ---------- historique ----------
async function commit(fn) {
  if (S.busy) return false;
  setBusy(true, "Application de la modification…");
  let snap = null, committed = false;
  try {
    snap = engine.snapshot();
    await fn();
    S.undo.push({ bytes: snap, stateId: S.stateId });
    if (S.undo.length > 12) S.undo.shift();
    S.stateId = ++S.stateSeq;
    S.redo = [];
    if (trimHistory()) toast("Pour préserver la mémoire, les étapes les plus anciennes de l’historique ont été supprimées.");
    committed = true;
    return true;
  } catch (e) {
    console.error(e);
    if (snap) { try { S.count = engine.open(snap); } catch (restoreError) { console.error("Rollback failed", restoreError); } }
    toast("Modification impossible : " + (e.message || e));
    return false;
  } finally {
    try {
      if (S.count) {
        S.count = engine.pageCount();
        S.page = Math.max(0, Math.min(S.page, S.count - 1));
        await refresh();
        if (committed) await renderThumbnails();
      }
    } catch (e) { console.error("Refresh failed", e); toast("La modification a réussi, mais l’aperçu n’a pas pu être actualisé. Réessayez ou rechargez le document."); }
    setBusy(false);
  }
}
async function swap(from, to) {
  if (!from.length) return;
  if (S.busy) return;
  setBusy(true, "Restauration de l’historique…");
  const target = from.pop();
  let current = null;
  try {
    current = { bytes: engine.snapshot(), stateId: S.stateId };
    to.push(current);
    trimHistory();
    S.count = engine.open(target.bytes); S.stateId = target.stateId;
    S.sel = null; S.ed = null; S.page = Math.min(S.page, S.count - 1);
    await refresh(); await renderThumbnails();
  } catch (e) {
    if (to.at(-1) === current) to.pop();
    if (current) { try { S.count = engine.open(current.bytes); S.stateId = current.stateId; } catch (restoreError) { console.error("History rollback failed", restoreError); } }
    from.push(target); console.error(e); toast("Impossible de restaurer cette étape de l’historique.");
  } finally { setBusy(false); }
}
$("#undo").onclick = () => swap(S.undo, S.redo);
$("#redo").onclick = () => swap(S.redo, S.undo);

// ---------- affichage ----------
async function refresh() {
  closeEditor();
  S.size = engine.pageSize(S.page);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = engine.render(S.page, safeRenderScale(S.size, S.zoom * dpr));
  cv.width = r.width; cv.height = r.height;
  cv.style.width = S.size.w * S.zoom + "px"; cv.style.height = S.size.h * S.zoom + "px";
  cv.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(r.pixels, r.width, r.height), 0, 0);
  S.model = engine.model(S.page);
  S.info = engine.documentInfo();
  S.metadata = S.info.metadata;
  S.pageMeta = engine.pageInfo(S.page);
  try { S.widgets = engine.widgets(S.page); } catch (e) { console.error("Widgets failed", e); S.widgets = []; }
  S.sel = S.sel && S.model.images.find((i) => close4(i.bbox, S.sel.bbox)) || null;
  drawOverlay(); updateChrome(); renderPanel();
}
const close4 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1.5);

function updateChrome() {
  $("#save").disabled = !S.count || S.busy;
  $("#open").disabled = S.busy;
  $("#undo").disabled = !S.undo.length || S.busy; $("#redo").disabled = !S.redo.length || S.busy;
  $("#zlabel").textContent = Math.round(S.zoom * 100) + "%";
  $("#pageinfo").textContent = S.count ? `${S.page + 1} / ${S.count}` : "–";
  $("#prev").disabled = S.page <= 0 || S.busy; $("#next").disabled = S.page >= S.count - 1 || S.busy;
  document.querySelectorAll("#tools button").forEach((b) => { b.classList.toggle("on", b.dataset.tool === S.tool); b.disabled = S.busy; });
  $("#zin").disabled = $("#zout").disabled = $("#fit").disabled = S.busy;
  ov.className = "t-" + S.tool;
  const labels = { select: "Modifier un élément", addtext: "Cliquez sur la page pour ajouter du texte", addimage: "Choisissez une image à insérer", patch: "Tracez la zone de texte à retoucher" };
  $("#toolStatus").textContent = S.count ? labels[S.tool] : "Prêt à modifier";
  if (S.count) {
    const locked = S.info?.encryption && S.info.encryption !== "None" ? " · chiffré" : "";
    $("#docMeta").textContent = `${S.count} ${S.count > 1 ? "pages" : "page"} · page ${S.page + 1} active${locked} · local`;
    updateThumbActive();
  }
}

function box(el, [x0, y0, x1, y1], pad = 0) {
  const z = S.zoom;
  Object.assign(el.style, { left: x0 * z - pad + "px", top: y0 * z - pad + "px", width: (x1 - x0) * z + pad * 2 + "px", height: (y1 - y0) * z + pad * 2 + "px" });
}

function drawOverlay() {
  ov.innerHTML = "";
  if (S.tool === "select") {
    for (const u of S.model.units) {
      const d = document.createElement("div"); d.className = "hit"; box(d, u.bbox, 2);
      d.onclick = (e) => { e.stopPropagation(); S.sel = null; openEditor(u); };
      ov.append(d);
    }
    for (const im of S.model.images) {
      if (S.sel && S.sel.id === im.id) continue;
      const d = document.createElement("div"); d.className = "hit img"; box(d, im.bbox);
      d.onclick = (e) => { e.stopPropagation(); S.sel = im; drawOverlay(); renderPanel(); };
      ov.prepend(d);
    }
    if (S.sel) drawSelection(S.sel);
  }
}

// ---------- sélection d'image: déplacer / redimensionner ----------
function drawSelection(im) {
  const el = document.createElement("div"); el.className = "sel"; box(el, im.bbox); ov.append(el);
  let rect = [...im.bbox];
  const place = () => box(el, rect);
  const start = (e, mode) => {
    e.stopPropagation(); e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, orig = [...im.bbox], ratio = (orig[2] - orig[0]) / (orig[3] - orig[1]);
    const mv = (m) => {
      const dx = (m.clientX - x0) / S.zoom, dy = (m.clientY - y0) / S.zoom;
      let [a, b, c, d] = orig;
      if (mode === "move") { a += dx; c += dx; b += dy; d += dy; }
      else {
        if (mode.includes("w")) a += dx; if (mode.includes("e")) c += dx;
        if (mode.includes("n")) b += dy; if (mode.includes("s")) d += dy;
        if (mode.length === 2 && !m.altKey) { // coins: proportions conservées
          const w = c - a; const h = w / ratio;
          if (mode.includes("n")) b = d - h; else d = b + h;
        }
        if (c - a < 8) c = a + 8; if (d - b < 8) d = b + 8;
      }
      rect = [a, b, c, d]; place();
    };
    const up = async () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      if (!close4(rect, orig)) await commit(() => engine.moveImage(S.page, im, S.model.images, rect));
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  el.onpointerdown = (e) => start(e, "move");
  for (const [mode, [fx, fy]] of Object.entries({ nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] })) {
    const h = document.createElement("i");
    Object.assign(h.style, { left: `calc(${fx * 100}% - 7px)`, top: `calc(${fy * 100}% - 7px)`, cursor: mode + "-resize" });
    h.onpointerdown = (e) => start(e, mode); el.append(h);
  }
}

// ---------- éditeur de texte ----------
function newUnit(x, y) {
  const size = 12;
  return {
    id: -1, isNew: true, bbox: [x, y - size, x + 160, y + size * 0.4], x, y, pitch: size * 1.2, align: "left", justify: false,
    multi: false, width: 160, paras: [""], mixed: false,
    style: { family: "serif", size, color: [0, 0, 0], bold: false, italic: false, fontKey: null },
  };
}

function sampleBg(rect) {
  // couleur dominante autour du rectangle (bords), lue sur le rendu
  const k = cv.width / S.size.w, c = cv.getContext("2d", { willReadFrequently: true });
  const [x0, y0, x1, y1] = rect.map((v) => v * k);
  const px = [];
  const grab = (x, y) => { x = Math.max(0, Math.min(cv.width - 1, x)); y = Math.max(0, Math.min(cv.height - 1, y)); px.push(c.getImageData(x | 0, y | 0, 1, 1).data); };
  for (let t = 0; t <= 1; t += 0.1) { grab(x0 + (x1 - x0) * t, y0 + 1); grab(x0 + (x1 - x0) * t, y1 - 1); grab(x0 + 1, y0 + (y1 - y0) * t); grab(x1 - 1, y0 + (y1 - y0) * t); }
  const med = (i) => px.map((p) => p[i]).sort((a, b) => a - b)[px.length >> 1] / 255;
  return [med(0), med(1), med(2)];
}

function openEditor(unit, bg = null) {
  closeEditor();
  const st = { ...unit.style, align: unit.align };
  st.fontKey = unit.isNew ? (unit.style.fontKey || null) : (unit.style.fontKey || unit.style.origFont || null);
  S.ed = { unit, st, bg };
  const ta = document.createElement("textarea"); ta.id = "ed"; ta.value = unit.paras.join("\n");
  S.ed.ta = ta; ov.append(ta);
  styleEditor(); renderPanel(); ta.focus();
  ta.oninput = autosize;
  ta.onkeydown = (e) => {
    if (e.key === "Escape") { closeEditor(); renderPanel(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyEditor(); }
  };
}

function fontCss(st) {
  const docFont = st.fontKey ? (S.model?.fonts || []).find((f) => f.name === st.fontKey) : null;
  if (docFont) return docFont.mono ? FAMILIES.mono.css : docFont.serif ? FAMILIES.serif.css : FAMILIES.sans.css;
  return FAMILIES[st.family]?.css || FAMILIES.serif.css;
}

function styleEditor() {
  const { unit, st, bg, ta } = S.ed, z = S.zoom;
  const b = bg ? bg.rect : unit.bbox;
  const bgc = bg ? bg.color : sampleBg(unit.bbox);
  const wPt = Math.max(b[2] - b[0], bg ? 0 : 60) + (unit.multi || bg ? 0 : 60);
  Object.assign(ta.style, {
    left: b[0] * z - 3 + "px", top: (bg ? b[1] : unit.bbox[1]) * z - 3 + "px", width: wPt * z + 6 + "px",
    minHeight: (b[3] - b[1]) * z + 6 + "px",
    fontFamily: fontCss(st), fontSize: st.size * z + "px",
    lineHeight: (unit.pitch * (st.size / unit.style.size)) * z + "px",
    fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? "italic" : "normal",
    color: hex(st.color), textAlign: st.align === "left" && unit.justify ? "justify" : st.align,
    background: hex(bgc),
  });
  autosize();
}
function autosize() { const ta = S.ed.ta; ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }
function closeEditor() { if (S.ed) { S.ed.ta.remove(); S.ed = null; } }

async function applyEditor() {
  const { unit, st, bg, ta } = S.ed;
  const text = ta.value, page = S.page;
  const opts = {
    text, family: st.family, size: st.size, color: st.color, bold: st.bold, italic: st.italic, align: st.align,
    pitch: unit.pitch * (st.size / unit.style.size),
    fontKey: st.fontKey || null,
  };
  closeEditor();
  let result = null;
  const ok = await commit(async () => {
    if (bg) {
      engine.fillRect(page, bg.rect, bg.color);
      if (text.trim()) result = await engine.drawText(page, { x: bg.rect[0] + 1, y: bg.rect[1] + st.size * 0.9, width: bg.rect[2] - bg.rect[0] - 2, justify: false, ...opts });
    } else if (unit.isNew) {
      if (text.trim()) result = await engine.drawText(page, { x: unit.x, y: unit.y, ...opts });
    } else result = await engine.replaceText(page, unit, opts);
  });
  if (!ok) return;
  if (result?.requested) toast(`Police d'origine sans les glyphes « ${result.missing.join(" ")} » : substitution appliquée.`);
  else if (result?.fidelity === "original") toast("Texte réécrit avec la police embarquée du document.");
}

// ---------- panneau de droite ----------
function renderPanel() {
  if (S.ed) return panelText();
  if (S.sel) return panelImage();
  panelDoc();
}

function panelDoc() {
  if (!S.count) {
    panel.innerHTML = `<h2>Outils</h2><p>Ouvrez un PDF pour commencer. Le document reste sur cet appareil : aucune donnée n’est envoyée.</p>`;
    return;
  }
  const info = S.info || engine.documentInfo();
  const meta = S.metadata || info.metadata || {};
  const pm = S.pageMeta || { rotation: 0, annotations: 0, widgets: 0, links: 0, label: "" };
  const encrypted = info.encryption && info.encryption !== "None";
  const enter = (k, title, body) => `<details data-k="${k}" ${S.openSections.has(k) ? "open" : ""}><summary>${title}</summary><div class="body">${body}</div></details>`;
  const field = (id, label, value) => `<label for="${id}">${label}</label><input id="${id}" class="meta-in" type="text" value="${esc(value || "")}">`;

  const metaBody = `
    ${field("mt-title", "Titre", meta.title)}
    ${field("mt-author", "Auteur", meta.author)}
    ${field("mt-subject", "Sujet", meta.subject)}
    ${field("mt-keywords", "Mots-clés", meta.keywords)}
    <div class="stack"><button class="primary" id="mt-save">Enregistrer les métadonnées</button></div>
    <div class="save-note">Créé : ${esc(pdfDate(meta.creationDate))}<br>Modifié : ${esc(pdfDate(meta.modDate))}</div>`;

  const pageBody = `
    <div class="doc-line"><span>Page</span><b>${S.page + 1} / ${S.count}</b></div>
    <div class="doc-line"><span>Format</span><b>${Math.round(S.size.w)} × ${Math.round(S.size.h)} pt</b></div>
    <div class="doc-line"><span>Rotation</span><b>${pm.rotation}°</b></div>
    <div class="grid-actions">
      <button id="pg-rotl">↺ Pivoter −90°</button>
      <button id="pg-rotr">↻ Pivoter +90°</button>
      <button id="pg-dup">Dupliquer</button>
      <button class="danger" id="pg-del">Supprimer</button>
      <button id="pg-up" ${S.page === 0 ? "disabled" : ""}>Monter</button>
      <button id="pg-down" ${S.page >= S.count - 1 ? "disabled" : ""}>Descendre</button>
      <button class="wide" id="pg-ins">Insérer un PDF après cette page…</button>
      <button class="wide" id="pg-ext">Extraire cette page…</button>
      <button class="wide" id="pg-merge">Fusionner un PDF à la fin…</button>
    </div>`;

  const formBody = S.widgets.map((w) => {
    const id = `fw-${w.id}`;
    const dis = w.readOnly ? "disabled" : "";
    let control;
    if (w.type === "text") {
      control = w.multiline
        ? `<textarea id="${id}" data-w="${w.id}" class="meta-in" style="height:64px;padding:6px 8px" ${dis}>${esc(w.value)}</textarea>`
        : `<input id="${id}" data-w="${w.id}" class="meta-in" type="${w.password ? "password" : "text"}" value="${esc(w.value)}" ${dis}>`;
    } else if (w.type === "combobox" || w.type === "listbox") {
      const opts = (w.options || []).map((o) => `<option ${o === w.value ? "selected" : ""}>${esc(o)}</option>`).join("");
      control = `<select id="${id}" data-w="${w.id}" ${dis}>${opts}</select>`;
    } else if (w.type === "checkbox" || w.type === "radiobutton") {
      const on = w.value && w.value !== "Off";
      control = `<label style="font-weight:400;margin:0"><input id="${id}" data-w="${w.id}" type="checkbox" ${on ? "checked" : ""} ${dis}> ${on ? "Coché" : "Décoché"}</label>`;
    } else {
      control = `<div class="note" style="margin:0">${esc(w.value || `Champ non modifiable (${w.type})`)}</div>`;
    }
    return `<div class="fm-field"><label for="${id}">${esc(w.label || w.name)}</label>${control}${w.readOnly ? '<div class="hint">Lecture seule</div>' : ""}</div>`;
  }).join("");

  const formsBody = S.widgets.length
    ? `${formBody}<div class="stack"><button class="primary" id="fm-apply">Appliquer les champs</button></div><div class="save-note">Les valeurs sont écrites dans les champs du formulaire, sans aplatir la page.</div>`
    : `<p style="margin:0">Aucun champ de formulaire sur cette page.</p>`;

  const invBody = `
    <div class="chips">
      <span class="chip ${encrypted ? "ok" : ""}">${encrypted ? "Chiffrement conservé" : "Non chiffré"}</span>
      ${info.repaired ? '<span class="chip warn">Structure réparée à l’ouverture</span>' : ""}
      <span class="chip">${S.count} page${S.count > 1 ? "s" : ""}</span>
      <span class="chip">${info.bookmarks} signet${info.bookmarks > 1 ? "s" : ""}</span>
      <span class="chip">${info.layers} calque${info.layers > 1 ? "s" : ""}</span>
    </div>
    <div class="doc-line"><span>Pièces jointes</span><b>${info.attachments.length ? esc(info.attachments.join(", ")) : "Aucune"}</b></div>
    <div class="doc-line"><span>Annotations (page)</span><b>${pm.annotations}</b></div>
    <div class="doc-line"><span>Champs (page)</span><b>${pm.widgets}</b></div>
    <div class="doc-line"><span>Liens (page)</span><b>${pm.links}</b></div>
    <div class="doc-line"><span>Version PDF</span><b>${pdfVersion(info.version)}</b></div>
    <div class="doc-line"><span>Producteur</span><b>${esc(meta.producer || "—")}</b></div>
    <div class="doc-line"><span>Créateur</span><b>${esc(meta.creator || "—")}</b></div>
    <div class="save-note">L’export fidélité conserve les pièces jointes, signets, formulaires, annotations, images, calques, métadonnées et le chiffrement.</div>`;

  const expBody = `
    <div class="radio-row">
      <label><input type="radio" name="expmode" value="fidelity" ${S.exportMode === "fidelity" ? "checked" : ""}><span><b>Fidélité intégrale</b><small>Conserve tous les objets du fichier. Fichier plus volumineux.</small></span></label>
      <label><input type="radio" name="expmode" value="compact" ${S.exportMode === "compact" ? "checked" : ""}><span><b>Compact</b><small>Compacte une copie ; les objets inutilisés sont supprimés, les éléments référencés restent.</small></span></label>
    </div>
    <div class="save-note">Fichier : ${esc(cleanBaseName(S.name))}${S.exportMode === "compact" ? "-compact" : "-modifie"}.pdf</div>`;

  const tips = {
    select: "Cliquez sur un texte pour le modifier, ou sur une image pour la déplacer, la redimensionner, la remplacer ou la supprimer.",
    addtext: "Cliquez sur la page pour ajouter un texte.",
    addimage: "Choisissez une image : elle sera placée au centre de la page.",
    patch: "Pour changer un texte qui fait partie d’une image, tracez un rectangle sur ce texte.",
  };
  const noText = S.model && !S.model.units.length && S.model.images.length
    ? `<div class="warn">Cette page ne contient pas de texte sélectionnable (image ou scan). Utilisez « Retoucher une image » pour modifier un texte à l’intérieur.</div>` : "";

  panel.innerHTML = `<h2>Document</h2>
    <p>${S.count ? tips[S.tool] : ""}</p>${noText}
    ${enter("meta", "Métadonnées", metaBody)}
    ${enter("pages", "Pages et formulaire", pageBody + formsBody)}
    ${enter("integrity", encrypted ? "Intégrité et chiffrement" : "Intégrité du document", invBody)}
    ${enter("export", "Export", expBody)}`;

  panel.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) S.openSections.add(d.dataset.k); else S.openSections.delete(d.dataset.k);
  }));
  panel.querySelectorAll('[name="expmode"]').forEach((r) => r.onchange = () => { S.exportMode = r.value; panelDoc(); });

  $("#mt-save").onclick = async () => {
    const values = {
      title: $("#mt-title").value, author: $("#mt-author").value,
      subject: $("#mt-subject").value, keywords: $("#mt-keywords").value,
    };
    if (await commit(() => engine.setMetadata(values))) toast("Métadonnées enregistrées.");
  };

  $("#pg-rotl").onclick = async () => { if (await commit(() => engine.rotatePage(S.page, -90))) toast("Page pivotée."); };
  $("#pg-rotr").onclick = async () => { if (await commit(() => engine.rotatePage(S.page, 90))) toast("Page pivotée."); };
  $("#pg-dup").onclick = async () => {
    if (await commit(() => { S.count = engine.duplicatePage(S.page); S.page = Math.min(S.page + 1, S.count - 1); })) toast("Page dupliquée.");
  };
  $("#pg-del").onclick = async () => {
    if (S.count <= 1) return toast("Un PDF doit conserver au moins une page.");
    if (!confirm(`Supprimer la page ${S.page + 1} ? L’action est réversible avec Annuler.`)) return;
    if (await commit(() => engine.deletePage(S.page))) toast("Page supprimée. Utilisez Annuler pour revenir en arrière.");
  };
  $("#pg-up").onclick = async () => {
    if (S.page <= 0) return;
    if (await commit(() => { engine.movePage(S.page, S.page - 1); S.page--; })) toast("Page déplacée.");
  };
  $("#pg-down").onclick = async () => {
    if (S.page >= S.count - 1) return;
    if (await commit(() => { engine.movePage(S.page, S.page + 1); S.page++; })) toast("Page déplacée.");
  };
  $("#pg-ins").onclick = async () => {
    try {
      const bytes = await pickPdfBytes(); if (!bytes) return;
      if (await commit(() => { const r = engine.insertPages(bytes, S.page + 1); S.count = r.count; S.page = r.at; })) toast("PDF inséré.");
    } catch (e) { toast(e.message || "PDF non lisible."); }
  };
  $("#pg-merge").onclick = async () => {
    try {
      const bytes = await pickPdfBytes(); if (!bytes) return;
      if (await commit(() => { const r = engine.insertPages(bytes, engine.pageCount()); S.count = r.count; })) toast("PDF fusionné à la fin.");
    } catch (e) { toast(e.message || "PDF non lisible."); }
  };
  $("#pg-ext").onclick = () => {
    try {
      const bytes = engine.extractPages([S.page]);
      downloadBytes(bytes, `${cleanBaseName(S.name)}-page-${S.page + 1}.pdf`);
      toast("Page extraite localement.");
    } catch (e) { toast(e.message || "Extraction impossible."); }
  };

  if ($("#fm-apply")) $("#fm-apply").onclick = async () => {
    const values = [];
    for (const w of S.widgets) {
      const el = panel.querySelector(`[data-w="${w.id}"]`);
      if (!el || w.readOnly) continue;
      values.push([w.id, (w.type === "checkbox" || w.type === "radiobutton") ? el.checked : el.value]);
    }
    if (await commit(() => { for (const [id, v] of values) engine.setWidget(S.page, id, v); })) toast("Champs du formulaire mis à jour.");
  };
}

function panelText() {
  const { unit, st, bg } = S.ed;
  const docFonts = S.model?.fonts || [];
  const group = docFonts.length
    ? docFonts.map((f) => `<option value="doc:${esc(f.name)}" ${st.fontKey === f.name ? "selected" : ""}>${esc(f.label)}${f.bold ? " · gras" : ""}${f.italic ? " · italique" : ""}</option>`).join("")
    : `<option value="" disabled>Aucune police du document détectée</option>`;
  const fams = Object.entries(FAMILIES).map(([k, v]) => `<option value="fam:${k}" ${!st.fontKey && st.family === k ? "selected" : ""}>${v.label}</option>`).join("");
  const usingOriginal = Boolean(st.fontKey);
  panel.innerHTML = `<h2>${bg ? "Texte sur l'image" : unit.isNew ? "Nouveau texte" : "Modifier le texte"}</h2>
  ${unit.mixed ? `<div class="warn">Cette ligne mélange plusieurs styles (gras, couleurs…). Ils seront unifiés en un seul style.</div>` : ""}
  <label>Police</label><select id="pf"><optgroup label="Polices du document (fidélité)">${group}</optgroup><optgroup label="Substitution">${fams}</optgroup></select>
  ${unit.style.origFont ? `<div class="note">Police d'origine : ${esc(unit.style.origFont.replace(/^[A-Z]{6}\+/, ""))}${usingOriginal ? " — réutilisée à l’identique." : " — remplacée par une police de substitution."}</div>` : ""}
  <div class="row"><div><label>Taille (pt)</label><input id="ps" type="number" min="3" max="200" step="0.5" value="${+st.size.toFixed(1)}"></div>
  <div><label>Couleur</label><input id="pc" type="color" value="${hex(st.color)}"></div></div>
  ${bg ? `<label>Couleur du fond (masque)</label><input id="pb" type="color" value="${hex(bg.color)}">` : ""}
  <div class="row" style="margin-top:10px"><button id="pB" class="${st.bold ? "on" : ""}" title="Gras (substitution)"><b>G</b></button><button id="pI" class="${st.italic ? "on" : ""}" title="Italique (substitution)"><i>I</i></button>
  <button data-al="left" class="${st.align === "left" ? "on" : ""}">⟸</button><button data-al="center" class="${st.align === "center" ? "on" : ""}">↔</button><button data-al="right" class="${st.align === "right" ? "on" : ""}">⟹</button></div>
  <div class="stack"><button class="primary" id="pa">Appliquer (Ctrl+Entrée)</button><button id="px">Annuler (Échap)</button>
  ${!unit.isNew && !bg ? `<button class="danger" id="pd">Supprimer ce texte</button>` : ""}</div>
  <div class="note">Les retours à la ligne sont recalculés automatiquement ; une ligne vide sépare deux paragraphes.</div>`;

  $("#pf").onchange = (e) => {
    const value = e.target.value;
    if (value.startsWith("doc:")) {
      const name = value.slice(4), f = docFonts.find((x) => x.name === name);
      st.fontKey = name;
      if (f) { st.bold = f.bold; st.italic = f.italic; st.family = f.family; }
    } else if (value.startsWith("fam:")) {
      st.fontKey = null;
      st.family = value.slice(4);
    }
    panelText(); styleEditor();
  };
  $("#ps").oninput = (e) => { st.size = Math.max(3, Math.min(200, +e.target.value || st.size)); e.target.value = st.size; styleEditor(); };
  $("#pc").oninput = (e) => { st.color = unhex(e.target.value); styleEditor(); };
  if (bg) $("#pb").oninput = (e) => { bg.color = unhex(e.target.value); styleEditor(); };
  $("#pB").onclick = () => { st.bold = !st.bold; st.fontKey = null; panelText(); styleEditor(); };
  $("#pI").onclick = () => { st.italic = !st.italic; st.fontKey = null; panelText(); styleEditor(); };
  panel.querySelectorAll("[data-al]").forEach((b) => b.onclick = () => { st.align = b.dataset.al; panelText(); styleEditor(); });
  $("#pa").onclick = applyEditor;
  $("#px").onclick = () => { closeEditor(); renderPanel(); };
  if ($("#pd")) $("#pd").onclick = () => { S.ed.ta.value = ""; applyEditor(); };
}

function panelImage() {
  const im = S.sel, w = Math.round(im.bbox[2] - im.bbox[0]), h = Math.round(im.bbox[3] - im.bbox[1]);
  panel.innerHTML = `<h2>Image</h2><p>${w} × ${h} pt</p>
  <div class="note">Glissez l’image pour la déplacer, tirez les poignées pour la redimensionner (les coins gardent les proportions ; Alt pour les libérer).</div>
  <div class="stack"><button class="primary" id="pr">Modifier un texte dans cette image</button><button id="ir">Remplacer l’image…</button><button class="danger" id="id">Supprimer l’image</button><button id="ix">Terminer</button></div>`;
  $("#pr").onclick = () => {
    S.sel = null; S.tool = "patch"; closeEditor(); updateChrome(); drawOverlay(); renderPanel();
    toast("Tracez un rectangle autour du texte, même dans l’image de droite.");
  };
  $("#ir").onclick = async () => {
    const f = await pickFile($("#fimg")); if (!f) return;
    try {
      const img = await toUsableImage(f);
      const [a, b, c, d] = im.bbox, bw = c - a, bh = d - b, k = Math.min(bw / img.w, bh / img.h);
      const rw = img.w * k, rh = img.h * k, rx = a + (bw - rw) / 2, ry = b + (bh - rh) / 2;
      await commit(() => engine.replaceImage(S.page, im, S.model.images, img.bytes, [rx, ry, rx + rw, ry + rh]));
    } catch (e) { toast("Image non lisible."); }
  };
  $("#id").onclick = () => { S.sel = null; commit(() => engine.deleteImage(S.page, im, S.model.images)); };
  $("#ix").onclick = () => { S.sel = null; drawOverlay(); renderPanel(); };
}

// ---------- outils ----------
document.querySelectorAll("#tools button").forEach((b) => b.onclick = async () => {
  if (!S.count) return toast("Ouvrez d'abord un PDF.");
  S.tool = b.dataset.tool; S.sel = null; closeEditor();
  if (S.tool === "addimage") {
    const f = await pickFile($("#fimg")); S.tool = "select";
    if (f) try {
      const img = await toUsableImage(f);
      const w = Math.min(S.size.w * 0.4, img.w * 0.75), h = w * img.h / img.w;
      const rect = [(S.size.w - w) / 2, (S.size.h - h) / 2, (S.size.w + w) / 2, (S.size.h + h) / 2];
      await commit(() => engine.addImage(S.page, img.bytes, rect));
      S.sel = S.model.images.find((i) => close4(i.bbox, rect)) || null; drawOverlay(); renderPanel();
    } catch (e) { toast("Image non lisible."); }
  }
  updateChrome(); drawOverlay(); renderPanel();
});

const ptAt = (e) => { const r = ov.getBoundingClientRect(); return [(e.clientX - r.left) / S.zoom, (e.clientY - r.top) / S.zoom]; };
ov.addEventListener("pointerdown", (e) => {
  if (e.target !== ov && !(S.tool === "patch" || S.tool === "addtext")) return;
  if (S.tool === "select") { if (e.target === ov && (S.sel || S.ed)) { S.sel = null; closeEditor(); drawOverlay(); renderPanel(); } return; }
  if (e.target.id === "ed") return;
  e.preventDefault();
  const [x, y] = ptAt(e);
  if (S.tool === "addtext") {
    openEditor(newUnit(x, y + 10)); S.tool = "select"; updateChrome(); return;
  }
  if (S.tool === "patch") {
    closeEditor();
    const rb = document.createElement("div"); rb.className = "rubber"; ov.append(rb);
    const mv = (m) => { const [x2, y2] = ptAt(m); box(rb, [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)]); };
    const up = (m) => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up); rb.remove();
      const [x2, y2] = ptAt(m), rect = [Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)];
      if (rect[2] - rect[0] < 6 || rect[3] - rect[1] < 6) return;
      const color = sampleBg(rect), h = rect[3] - rect[1];
      const unit = newUnit(rect[0] + 1, rect[1] + h * 0.8);
      unit.style.size = Math.max(6, Math.min(48, Math.round(h * 0.8)));
      unit.style.color = lum(color) > 0.55 ? [0.05, 0.05, 0.05] : [1, 1, 1];
      unit.bbox = rect; unit.width = rect[2] - rect[0]; unit.pitch = unit.style.size * 1.2;
      openEditor(unit, { rect, color });
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  }
});

// ---------- navigation, zoom, clavier ----------
const go = (d) => { S.page = Math.max(0, Math.min(S.count - 1, S.page + d)); S.sel = null; refresh(); };
$("#prev").onclick = () => go(-1); $("#next").onclick = () => go(1);
const zoom = (f) => { S.zoom = Math.max(0.3, Math.min(4, S.zoom * f)); if (S.count) refresh(); };
$("#zin").onclick = () => zoom(1.2); $("#zout").onclick = () => zoom(1 / 1.2);
$("#fit").onclick = () => {
  if (!S.count) return;
  const available = Math.max(280, $("#stage").clientWidth - 72);
  S.zoom = Math.max(0.3, Math.min(2.4, available / S.size.w));
  refresh();
};
addEventListener("keydown", (e) => {
  if (S.busy) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  const typing = Boolean(e.target?.isContentEditable || e.target?.matches(
    "textarea, select, input:not([type]), input[type='text'], input[type='number'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='password']",
  ));
  if (mod && key === "s") { e.preventDefault(); if (S.count) $("#save").click(); }
  else if (mod && !typing && (key === "z" || key === "y")) {
    e.preventDefault(); (key === "y" || e.shiftKey ? $("#redo") : $("#undo")).click();
  }
  else if (!typing && e.key === "PageUp") { e.preventDefault(); if (S.count) go(-1); }
  else if (!typing && e.key === "PageDown") { e.preventDefault(); if (S.count) go(1); }
  else if (!typing && e.key === "Home") { e.preventDefault(); if (S.count) { S.page = 0; refresh(); } }
  else if (!typing && e.key === "End") { e.preventDefault(); if (S.count) { S.page = S.count - 1; refresh(); } }
  else if (e.key === "Escape" && S.sel) { S.sel = null; drawOverlay(); renderPanel(); }
  else if (e.key === "Delete" && S.sel && !typing) $("#id")?.click();
});
addEventListener("beforeunload", (e) => {
  if (!hasUnsavedChanges()) return;
  e.preventDefault(); e.returnValue = "";
});

// ---------- démarrage ----------
renderPanel(); updateChrome();
$("#loading").remove();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
