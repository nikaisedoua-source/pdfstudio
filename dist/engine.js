// Moteur d'édition PDF (mupdf WASM). Fonctionne dans le navigateur et dans Node.
import * as mupdf from "./vendor/mupdf.js";

const WIN = {0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F};

export const FAMILIES = {
  serif:   { label: "Serif (Times)",    files: ["LiberationSerif-Regular","LiberationSerif-Bold","LiberationSerif-Italic","LiberationSerif-BoldItalic"], css: "'Liberation Serif', 'Times New Roman', serif" },
  sans:    { label: "Sans (Arial)",     files: ["LiberationSans-Regular","LiberationSans-Bold","LiberationSans-Italic","LiberationSans-BoldItalic"],     css: "'Liberation Sans', Arial, sans-serif" },
  carlito: { label: "Calibri",          files: ["Carlito-Regular","Carlito-Bold","Carlito-Italic","Carlito-BoldItalic"],                                   css: "Carlito, Calibri, sans-serif" },
  mono:    { label: "Mono (Courier)",   files: ["LiberationMono-Regular","LiberationMono-Bold","LiberationMono-Regular","LiberationMono-Bold"],           css: "'Liberation Mono', 'Courier New', monospace" },
};

export function guessFamily(fontName = "") {
  const n = fontName.toLowerCase();
  if (/calibri|carlito/.test(n)) return "carlito";
  if (/mono|courier|consol/.test(n)) return "mono";
  if (/times|serif|garamond|georgia|cambria|palatino|book|minion/.test(n) && !/sans/.test(n)) return "serif";
  if (/arial|helvet|sans|verdana|tahoma|segoe|roboto|open/.test(n)) return "sans";
  return "serif";
}

const INFO = {
  title: "info:Title", author: "info:Author", subject: "info:Subject", keywords: "info:Keywords",
  creator: "info:Creator", producer: "info:Producer", creationDate: "info:CreationDate", modDate: "info:ModDate",
};

function toRGB(c) {
  if (!c || !c.length) return [0, 0, 0];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 3) return [c[0], c[1], c[2]];
  const [C, M, Y, K] = c; // CMYK -> RGB approximatif
  return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
}

const enc = (s) => new TextEncoder().encode(s);
function winAnsi(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    const b = WIN[c] ?? (c < 256 ? c : 0x3F);
    if (b === 0x28 || b === 0x29 || b === 0x5C) out.push(0x5C);
    out.push(b);
  }
  return out;
}
const num = (n) => (Math.round(n * 1000) / 1000).toString();

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function quadRect(q) {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

let uid = 0;
const MAX_RENDER_PIXELS = 16_000_000;
const MAX_RENDER_SIDE = 10_000;

const cleanFontName = (name = "") => String(name).replace(/^[A-Z]{6}\+/, "") || "Police du document";

export class Engine {
  /** @param {(file:string)=>Promise<Uint8Array>|Uint8Array} loadFontFile */
  constructor(loadFontFile) {
    this.loadFontFile = loadFontFile;
    this.doc = null;
    this.fonts = new Map();          // polices de substitution ajoutées
    this.docFonts = new Map();       // polices trouvées dans le document
    this.docFontObjects = new Map(); // polices d'origine réinjectées
    this.password = null;            // mot de passe du document courant (jamais exporté)
    this.tag = Math.random().toString(36).slice(2, 6);
  }

  open(bytes, password = this.password) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new Error("Fichier PDF vide ou incomplet.");
    const header = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
    if (!header.includes("%PDF-")) throw new Error("Signature PDF absente.");
    let next;
    try { next = mupdf.PDFDocument.openDocument(bytes, "application/pdf"); }
    catch (e) { throw new Error("Ce fichier n’a pas pu être ouvert comme PDF : il est peut-être endommagé."); }
    if (next.needsPassword()) {
      if (password == null) {
        next.destroy();
        const err = new Error("Ce PDF est protégé par un mot de passe. Il est requis pour l’ouvrir.");
        err.code = "PASSWORD_REQUIRED";
        throw err;
      }
      if (!next.authenticatePassword(password)) {
        next.destroy();
        const err = new Error("Mot de passe incorrect.");
        err.code = "PASSWORD_INVALID";
        throw err;
      }
      this.password = password;
    } else this.password = null;
    let count;
    try { count = next.countPages(); }
    catch (e) { next.destroy(); throw new Error("Le document ne contient aucune page lisible."); }
    if (!Number.isInteger(count) || count < 1) { next.destroy(); throw new Error("Le document ne contient aucune page lisible."); }
    const previous = this.doc;
    this.doc = next;
    this.fonts.clear();
    this.docFonts.clear();
    this.docFontObjects.clear();
    previous?.destroy();
    return count;
  }

  pageCount() { return this.doc.countPages(); }

  _save(options) {
    const buffer = this.doc.saveToBuffer(options);
    try { return buffer.asUint8Array().slice(); }
    finally { buffer.destroy(); }
  }

  _openInternal(bytes) {
    const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
    if (doc.needsPassword() && !(this.password && doc.authenticatePassword(this.password))) {
      doc.destroy();
      const err = new Error("Le document chiffré doit être déverrouillé à nouveau.");
      err.code = "PASSWORD_REQUIRED";
      throw err;
    }
    return doc;
  }

  // Instantané fidèle : aucun objet n'est supprimé, le document de travail reste intact.
  snapshot() { return this._save("garbage=no"); }

  /**
   * Export. mode = "fidelity" conserve tous les objets référencés du document
   * (pièces jointes, formulaires, annotations, signets, calques, métadonnées, chiffrement)
   * et retire uniquement les objets devenus inaccessibles après une suppression.
   * mode = "compact" compacte une copie pour réduire la taille.
   */
  save(mode = "fidelity") {
    if (mode === "compact") {
      const tmp = this._openInternal(this.snapshot());
      try {
        const buffer = tmp.saveToBuffer("garbage=compact,compress");
        try { return buffer.asUint8Array().slice(); }
        finally { buffer.destroy(); }
      } finally { tmp.destroy(); }
    }
    // garbage=no conserverait les anciens flux de contenu, donc le texte supprimé.
    return this._save("garbage=yes");
  }

  pageSize(i) {
    const page = this.doc.loadPage(i);
    try {
      const b = page.getBounds(), w = b[2] - b[0], h = b[3] - b[1];
      if (![w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new Error("Dimensions de page PDF invalides.");
      return { w, h };
    } finally { page.destroy(); }
  }

  pageInfo(i) {
    const page = this.doc.loadPage(i);
    try {
      const o = page.getObject();
      const rot = o.getInheritable("Rotate");
      let label = "";
      try { label = page.getLabel() || ""; } catch {}
      return {
        rotation: rot.isNumber() ? ((Math.round(rot.asNumber() / 90) * 90) % 360 + 360) % 360 : 0,
        label,
        annotations: page.getAnnotations().length,
        widgets: page.getWidgets().length,
        links: page.getLinks().length,
      };
    } finally { page.destroy(); }
  }

  render(i, scale) {
    const page = this.doc.loadPage(i);
    let pm;
    try {
      const b = page.getBounds(), wPt = b[2] - b[0], hPt = b[3] - b[1];
      if (![wPt, hPt, scale].every(Number.isFinite) || wPt <= 0 || hPt <= 0 || scale <= 0) throw new Error("Paramètres de rendu PDF invalides.");
      const bounded = Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / (wPt * hPt)), MAX_RENDER_SIDE / Math.max(wPt, hPt));
      pm = page.toPixmap(mupdf.Matrix.scale(bounded, bounded), mupdf.ColorSpace.DeviceRGB, false);
      const w = pm.getWidth(), h = pm.getHeight(), stride = pm.getStride(), n = pm.getNumberOfComponents();
      if (w * h > MAX_RENDER_PIXELS * 1.02) throw new Error("La page dépasse la mémoire de rendu autorisée.");
      const src = pm.getPixels(), out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        let s = y * stride, o = y * w * 4;
        for (let x = 0; x < w; x++, s += n, o += 4) { out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = 255; }
      }
      return { width: w, height: h, pixels: out };
    } finally { pm?.destroy(); page.destroy(); }
  }

  /** Lit le contenu éditable de la page : unités de texte (blocs ou lignes), glyphes et images. */
  model(i) {
    const page = this.doc.loadPage(i);
    let st;
    try {
      st = page.toStructuredText("preserve-images");
      const blocks = [], images = [], fonts = new Map();
      let blk = null, ln = null;
      st.walk({
        onImageBlock: (bbox, _t, image) => images.push({ id: images.length, bbox: [...bbox], image }),
        beginTextBlock: () => { blk = { lines: [] }; },
        beginLine: (bbox) => { ln = { bbox: [...bbox], text: "", x: null, y: null, style: null, mixed: false, glyphs: [], size: null }; },
        onChar: (c, origin, font, size, _q, color, _bidi) => {
          const fontName = font.getName();
          const style = { font: fontName, size, color: toRGB(color), bold: font.isBold(), italic: font.isItalic() };
          this.docFonts.set(fontName, font);
          if (!fonts.has(fontName)) fonts.set(fontName, {
            name: fontName, label: cleanFontName(fontName),
            bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono(),
            family: guessFamily(fontName),
          });
          // CORRECTION: Assigner le style même pour les espaces seuls, pour détecter tous les blocs
          if (ln.style === null) { ln.x = origin[0]; ln.y = origin[1]; ln.style = style; ln.size = size; }
          else if (c.trim() !== "" &&
            (Math.abs(ln.style.size - size) > 0.3 || ln.style.font !== style.font || ln.style.color.join() !== style.color.join())) ln.mixed = true;
          ln.text += c;
          if (ln.size === null) ln.size = size;
          const q = _q ? quadRect(_q) : [origin[0], origin[1], origin[0] + size * 0.5, origin[1] + size];
          ln.glyphs.push({ c, quad: [..._q], rect: q, origin: [...origin], size, font: fontName });
        },
        endLine: () => { 
          ln.text = ln.text.replace(/\s+$/, ""); 
          // CORRECTION: Accepter les lignes avec style même si le texte est vide après trim
          if (ln.style) blk.lines.push(ln); 
          ln = null; 
        },
        endTextBlock: () => { if (blk.lines.length) blocks.push(blk); blk = null; },
      });

      // Unités éditables: un bloc entier si son style est uniforme, sinon ligne par ligne.
      const units = [];
      const same = (a, b) => Math.abs(a.size - b.size) <= 0.3 && a.font === b.font && a.color.join() === b.color.join();
      for (const b of blocks) {
        const uniform = b.lines.every((l) => !l.mixed && same(l.style, b.lines[0].style));
        const groups = uniform ? [b.lines] : b.lines.map((l) => [l]);
        for (const g of groups) units.push(this._unit(g, units.length));
      }
      return { units, images, fonts: [...fonts.values()] };
    } finally {
      st?.destroy();
      page.destroy();
    }
  }

  _metric(family) {
    const name = family === "serif" ? "Times-Roman" : family === "mono" ? "Courier" : "Helvetica";
    if (!this._metrics) this._metrics = {};
    return (this._metrics[name] ??= new mupdf.Font(name));
  }

  _unit(lines, id) {
    const x0 = Math.min(...lines.map((l) => l.bbox[0])), y0 = Math.min(...lines.map((l) => l.bbox[1]));
    const x1 = Math.max(...lines.map((l) => l.bbox[2])), y1 = Math.max(...lines.map((l) => l.bbox[3]));
    const st = lines[0].style;
    const family = guessFamily(st.font);
    const metric = this._metric(family);
    const wid = (t) => this._width(metric, t, st.size);

    // interligne
    let pitch = st.size * 1.2;
    if (lines.length > 1) {
      const d = []; for (let k = 1; k < lines.length; k++) d.push(lines[k].y - lines[k - 1].y);
      const pos = d.filter((v) => v > st.size * 0.5).sort((a, b) => a - b);
      if (pos.length) { const base = pos[0]; const close = pos.filter((v) => v < base * 1.6); pitch = close[Math.floor(close.length / 2)]; }
    }
    // alignement
    let align = "left";
    const spread = (a) => Math.max(...a) - Math.min(...a);
    if (lines.length > 1) {
      const L = lines.map((l) => l.bbox[0]), R = lines.map((l) => l.bbox[2]);
      const cx = lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2);
      if (spread(L) < 1.5) align = "left";
      else if (spread(R) < 1.5) align = "right";
      else if (spread(cx) < 2) align = "center";
    }
    // justification: plusieurs lignes non finales avec le même bord droit
    const flush = lines.filter((l, k) => k < lines.length - 1 && Math.abs(l.bbox[2] - x1) <= 1.5 && lines[k + 1].y - l.y < pitch * 1.5).length;
    const justify = lines.length > 1 && align === "left" && flush >= 2;
    const W = x1 - x0, space = wid(" ");

    // paragraphes: relie les lignes coupées automatiquement, garde les lignes vides
    const paras = []; let cur = null, prev = null;
    for (const l of lines) {
      let gap = 1;
      if (prev) gap = Math.max(1, Math.round((l.y - prev.y) / pitch));
      let join = false;
      if (cur !== null && gap === 1 && align !== "center") {
        const next = l.text.split(/\s+/)[0];
        join = prev.bbox[2] >= x1 - 1.5 || (prev.bbox[2] - x0) + space + wid(next) > W + 0.5;
      }
      if (join) cur += " " + l.text;
      else { if (cur !== null) paras.push(cur); for (let g = 1; g < gap; g++) paras.push(""); cur = l.text; }
      prev = l;
    }
    if (cur !== null) paras.push(cur);
    // CORRECTION: Toujours créer au moins un paragraphe, même si vide
    if (paras.length === 0) paras.push("");

    const glyphs = lines.flatMap((l) => l.glyphs).filter((g) => g.c.trim() !== "" && g.rect[2] > g.rect[0] && g.rect[3] > g.rect[1]);

    return {
      id, bbox: [x0, y0, x1, y1], x: lines[0].x, y: lines[0].y, pitch, align, justify,
      multi: lines.length > 1, width: W, paras, mixed: lines.some((l) => l.mixed), glyphs,
      lines: lines.map((l) => ({ bbox: [...l.bbox], x: l.x, y: l.y, text: l.text, size: l.size })),
      style: { family, size: st.size, color: st.color, bold: st.bold, italic: st.italic, origFont: st.font, fontKey: st.font },
    };
  }

  // ---------- Polices ----------
  async _font(family, bold, italic, unicode = false) {
    const key = `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}|${unicode ? "cid" : "latin"}`;
    if (this.fonts.has(key)) return this.fonts.get(key);
    const files = FAMILIES[family].files;
    const file = files[(bold ? 1 : 0) + (italic ? 2 : 0)];
    const data = await this.loadFontFile(file + ".ttf");
    const font = new mupdf.Font(file, data);
    const obj = unicode ? this.doc.addFont(font) : this.doc.addSimpleFont(font, "Latin");
    const rec = { font, obj, name: `FEd${this.tag}${++uid}`, cid: unicode, original: false };
    this.fonts.set(key, rec);
    return rec;
  }

  _originalFont(fontName, bold, italic) {
    const font = this.docFonts.get(fontName);
    if (!font) return null;
    if (Boolean(bold) !== font.isBold() || Boolean(italic) !== font.isItalic()) return null;
    let rec = this.docFontObjects.get(fontName);
    if (!rec) {
      rec = { font, obj: this.doc.addFont(font), name: `FOrig${this.tag}${++uid}`, cid: true, original: true };
      this.docFontObjects.set(fontName, rec);
    }
    return rec;
  }

  canType(fontName, text) {
    const font = this.docFonts.get(fontName);
    if (!font) return { ok: false, missing: [...String(text)] };
    const missing = [];
    for (const ch of String(text)) {
      if (ch === "\n" || ch === "\r") continue;
      const gid = font.encodeCharacter(ch.codePointAt(0));
      if (!gid) missing.push(ch);
    }
    return { ok: missing.length === 0, missing: [...new Set(missing)] };
  }

  _width(font, str, size) {
    let w = 0;
    for (const ch of str) {
      const gid = font.encodeCharacter(ch.codePointAt(0));
      w += font.advanceGlyph(gid);
    }
    return w * size;
  }

  _wrap(font, text, size, maxW) {
    const out = [];
    for (const para of text.split("\n")) {
      if (!maxW) { out.push({ t: para, last: true }); continue; }
      const lines = []; let cur = "";
      for (const w of para.split(/(\s+)/)) {
        const t = cur + w;
        if (cur && this._width(font, t.trimEnd(), size) > maxW) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
        else cur = t;
      }
      lines.push(cur.trimEnd());
      lines.forEach((t, k) => out.push({ t, last: k === lines.length - 1 }));
    }
    return out;
  }

  // ---------- Ecriture dans la page ----------
  _resources(pageObject) {
    let resources = pageObject.get("Resources");
    if (!resources.isNull()) return resources;
    let inherited = null, p = pageObject.get("Parent");
    while (!p.isNull()) { const r = p.get("Resources"); if (!r.isNull()) { inherited = r; break; } p = p.get("Parent"); }
    const clone = this.doc.newDictionary();
    if (inherited) inherited.forEach((v, k) => clone.put(k, v));
    pageObject.put("Resources", clone);
    return clone;
  }

  _resourceDict(resources, kind) {
    let d = resources.get(kind);
    const clone = this.doc.newDictionary();
    if (!d.isNull() && d.isDictionary()) d.forEach((v, k) => clone.put(k, v));
    resources.put(kind, clone);
    return clone;
  }

  _append(pageIdx, bytes, res = {}) {
    const doc = this.doc;
    const page = doc.loadPage(pageIdx);
    const po = page.getObject();
    const resources = this._resources(po);
    for (const [kind, map] of [["Font", res.fonts], ["XObject", res.xobjects]]) {
      if (!map) continue;
      const d = this._resourceDict(resources, kind);
      for (const [k, v] of Object.entries(map)) d.put(k, v);
    }

    // Isoler le contenu d'origine (q ... Q) puis ajouter le nôtre
    const arr = doc.newArray();
    arr.push(doc.addStream(enc("q\n"), doc.newDictionary()));
    const old = po.get("Contents");
    if (old.isArray()) { for (let k = 0; k < old.length; k++) arr.push(old.get(k)); } else if (!old.isNull()) arr.push(old);
    arr.push(doc.addStream(enc("\nQ\n"), doc.newDictionary()));
    const T = invert(page.getTransform());
    const head = enc(`q ${T.map(num).join(" ")} cm\n`);
    const tail = enc("\nQ\n");
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    arr.push(doc.addStream(body, doc.newDictionary()));
    po.put("Contents", arr);
  }

  _redactRects(pageIdx, rects, { images = mupdf.PDFPage.REDACT_IMAGE_NONE, lineArt = mupdf.PDFPage.REDACT_LINE_ART_NONE, text = mupdf.PDFPage.REDACT_TEXT_REMOVE } = {}) {
    if (!rects.length) return;
    const page = this.doc.loadPage(pageIdx);
    for (const [x0, y0, x1, y1] of rects) {
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 - x0 < 0.2 || y1 - y0 < 0.2) continue;
      const a = page.createAnnotation("Redact");
      a.setRect([x0, y0, x1, y1]);
      a.setQuadPoints([[x0, y0, x1, y0, x0, y1, x1, y1]]);
    }
    page.applyRedactions(false, images, lineArt, text);
  }

  _redactionRectsFor(unit) {
    if (unit.glyphs?.length) {
      // Fusionne les glyphes voisins en petites passes pour ne retirer que le texte concerné.
      const rects = [];
      let run = null;
      for (const g of unit.glyphs) {
        const r = g.rect;
        if (!run) { run = [...r]; continue; }
        const gap = r[0] - run[2];
        const overlapY = Math.min(run[3], r[3]) - Math.max(run[1], r[1]);
        if (gap <= Math.max(0.8, g.size * 0.08) && overlapY > Math.min(run[3] - run[1], r[3] - r[1]) * 0.5) {
          run[0] = Math.min(run[0], r[0]); run[1] = Math.min(run[1], r[1]);
          run[2] = Math.max(run[2], r[2]); run[3] = Math.max(run[3], r[3]);
        } else {
          rects.push(run); run = [...r];
        }
      }
      if (run) rects.push(run);
      return rects.map(([x0, y0, x1, y1]) => [x0 - 0.15, y0 - 0.15, x1 + 0.15, y1 + 0.15]);
    }
    const [x0, y0, x1, y1] = unit.bbox;
    return [[x0 + 0.3, y0 + 0.3, x1 - 0.3, y1 - 0.3]];
  }

  /**
   * Remplace le texte d'une unité en conservant la police embarquée lorsque c'est possible.
   * opts: {text, family, size, color, bold, italic, align, fontKey}
   */
  async replaceText(pageIdx, unit, opts) {
    this._redactRects(pageIdx, this._redactionRectsFor(unit), { text: mupdf.PDFPage.REDACT_TEXT_REMOVE });
    const text = (opts.text ?? "").replace(/\s+$/, "");
    if (!text.trim()) return { fidelity: "removed" };
    return this.drawText(pageIdx, {
      x: unit.x, y: unit.y, width: unit.multi ? unit.width : null, pitch: unit.pitch,
      boxLeft: unit.bbox[0], boxRight: unit.bbox[2], justify: unit.justify,
      ...opts, text, align: opts.align || unit.align,
      fontKey: opts.fontKey === undefined ? (unit.style?.fontKey ?? unit.style?.origFont) : opts.fontKey,
    });
  }

  _resolveFont(o) {
    const name = o.fontKey || (o.keepFont !== false ? o.origFont : null);
    if (name) {
      const rec = this._originalFont(name, o.bold, o.italic);
      if (rec) {
        const miss = this.canType(name, o.text);
        if (miss.ok) return { rec, missing: [] };
        return { rec: null, missing: miss.missing, requested: name };
      }
    }
    return { rec: null, missing: [], requested: null };
  }

  /** Dessine du texte. {x,y(baseline 1re ligne),text,family,size,color,bold,italic,align,width?,pitch?,bg?,fontKey?} */
  async drawText(pageIdx, o) {
    const resolved = this._resolveFont(o);
    let rec = resolved.rec, missing = resolved.missing, requested = resolved.requested;
    const unicode = [...o.text].some((ch) => ch.codePointAt(0) > 255);
    if (!rec) rec = await this._font(o.family, o.bold, o.italic, unicode);
    const font = rec.font, name = rec.name;
    const size = o.size, pitch = o.pitch || size * 1.2;
    const pg = this.pageSize(pageIdx);
    const maxW = o.width ?? Math.max(20, pg.w - o.x - 10);
    const lines = this._wrap(font, o.text, size, o.width ? maxW * (o.justify ? 1.03 : 1.005) : maxW);
    const [r, g, b] = o.color;
    const parts = [];
    if (o.bg) {
      const [bx0, by0, bx1, by1] = o.bg.rect, [br, bg, bb] = o.bg.color;
      parts.push(enc(`${num(br)} ${num(bg)} ${num(bb)} rg ${num(bx0)} ${num(by0)} ${num(bx1 - bx0)} ${num(by1 - by0)} re f\n`));
    }
    parts.push(enc(`BT /${name} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg\n`));
    lines.forEach(({ t: line, last }, k) => {
      let x = o.x;
      const w = this._width(font, line, size);
      const left = o.boxLeft ?? o.x, right = o.boxRight ?? (o.x + (o.width ?? w));
      if (o.align === "center") x = (left + right) / 2 - w / 2;
      else if (o.align === "right") x = right - w;
      const spaces = (line.match(/ /g) || []).length;
      const tw = o.justify && o.width && !last && spaces ? (o.width - w) / spaces : 0;
      const matrix = `${num(tw)} Tw 1 0 0 -1 ${num(x)} ${num(o.y + k * pitch)} Tm `;
      if (rec.cid) {
        let hex = "<";
        for (const ch of line) {
          const gid = font.encodeCharacter(ch.codePointAt(0));
          if (!gid) throw new Error(`La police sélectionnée ne contient pas le glyphe « ${ch} ».`);
          if (gid > 0xFFFF) throw new Error("Ce glyphe ne peut pas être encodé dans ce PDF.");
          hex += gid.toString(16).padStart(4, "0");
        }
        parts.push(enc(matrix + hex + "> Tj\n"));
      } else parts.push(enc(matrix + "("), new Uint8Array(winAnsi(line)), enc(") Tj\n"));
    });
    parts.push(enc("ET\n"));
    const len = parts.reduce((s, p) => s + p.length, 0);
    const buf = new Uint8Array(len); let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.length; }
    this._append(pageIdx, buf, { fonts: { [name]: rec.obj } });
    return { fidelity: rec.original ? "original" : "substitute", missing, requested };
  }

  // ---------- Images ----------
  _drawImage(pageIdx, imageObj, rect) {
    const name = `ImEd${this.tag}${++uid}`;
    const [x0, y0, x1, y1] = rect, w = x1 - x0, h = y1 - y0;
    const xo = this.doc.addImage(imageObj);
    const ops = enc(`q ${num(w)} 0 0 ${num(-h)} ${num(x0)} ${num(y1)} cm /${name} Do Q\n`);
    this._append(pageIdx, ops, { xobjects: { [name]: xo } });
  }

  _removeImageAt(pageIdx, img, allImages) {
    const [x0, y0, x1, y1] = img.bbox;
    const inter = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const others = allImages.filter((o) => o.id !== img.id && inter(o.bbox, img.bbox));
    const rect = [x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5];
    this._redactRects(pageIdx, [rect], {
      images: others.length ? mupdf.PDFPage.REDACT_IMAGE_PIXELS : mupdf.PDFPage.REDACT_IMAGE_REMOVE,
      text: mupdf.PDFPage.REDACT_TEXT_NONE,
    });
  }

  deleteImage(pageIdx, img, all) { this._removeImageAt(pageIdx, img, all); }

  moveImage(pageIdx, img, all, rect) {
    this._removeImageAt(pageIdx, img, all);
    this._drawImage(pageIdx, img.image, rect);
  }

  replaceImage(pageIdx, img, all, bytes, rect = img.bbox) {
    this._removeImageAt(pageIdx, img, all);
    this._drawImage(pageIdx, new mupdf.Image(bytes), rect);
  }

  addImage(pageIdx, bytes, rect) { this._drawImage(pageIdx, new mupdf.Image(bytes), rect); }

  /** Rectangle plein (pour masquer du texte dans une image) */
  fillRect(pageIdx, rect, color) {
    const [x0, y0, x1, y1] = rect, [r, g, b] = color;
    this._append(pageIdx, enc(`${num(r)} ${num(g)} ${num(b)} rg ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f\n`));
  }

  // ---------- Métadonnées et inventaire ----------
  metadata() {
    const out = {};
    for (const [k, key] of Object.entries(INFO)) {
      try { out[k] = this.doc.getMetaData(key) ?? ""; }
      catch { out[k] = ""; }
    }
    return out;
  }

  setMetadata(values) {
    for (const [k, v] of Object.entries(values || {})) {
      if (!INFO[k]) continue;
      this.doc.setMetaData(INFO[k], String(v ?? ""));
    }
    return this.metadata();
  }

  attachments() {
    try { return Object.keys(this.doc.getEmbeddedFiles() || {}); }
    catch { return []; }
  }

  _countOutline(items) {
    if (!Array.isArray(items)) return 0;
    return items.reduce((n, it) => n + 1 + this._countOutline(it.down), 0);
  }

  documentInfo() {
    let outline = null;
    try { outline = this.doc.loadOutline(); } catch {}
    let layers = 0;
    try { layers = this.doc.countLayers(); } catch {}
    return {
      pages: this.doc.countPages(),
      version: this.doc.getVersion?.() ?? "",
      repaired: this.doc.wasRepaired?.() ?? false,
      hasChanges: this.doc.hasUnsavedChanges?.() ?? false,
      encryption: this.doc.getMetaData("encryption") || "",
      attachments: this.attachments(),
      bookmarks: this._countOutline(outline),
      outline,
      layers,
      metadata: this.metadata(),
    };
  }

  // ---------- Pages ----------
  _invalidateDocFonts() {
    this.docFonts.clear();
    this.docFontObjects.clear();
  }

  rotatePage(i, delta) {
    const page = this.doc.loadPage(i);
    try {
      const obj = page.getObject();
      const cur = obj.getInheritable("Rotate");
      const base = cur.isNumber() ? cur.asNumber() : 0;
      obj.put("Rotate", ((Math.round((base + delta) / 90) * 90) % 360 + 360) % 360);
    } finally { page.destroy(); }
    return this.pageInfo(i).rotation;
  }

  deletePage(i) {
    if (this.doc.countPages() <= 1) throw new Error("Un PDF doit conserver au moins une page.");
    this.doc.deletePage(i);
    return this.doc.countPages();
  }

  movePage(from, to) {
    const n = this.doc.countPages();
    if (from < 0 || from >= n) throw new Error("Page source invalide.");
    to = Math.max(0, Math.min(n - 1, to));
    if (from === to) return this.doc.countPages();
    const order = Array.from({ length: n }, (_, k) => k);
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    this.doc.rearrangePages(order);
    return this.doc.countPages();
  }

  duplicatePage(i) {
    const src = this._openInternal(this.snapshot());
    try { this.doc.graftPage(Math.min(i + 1, this.doc.countPages()), src, i); }
    finally { src.destroy(); }
    this._invalidateDocFonts();
    return this.doc.countPages();
  }

  insertPages(bytes, at = this.doc.countPages()) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new Error("Fichier PDF invalide.");
    const src = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
    try {
      if (src.needsPassword()) {
        const err = new Error("Le PDF à insérer est protégé par un mot de passe.");
        err.code = "PASSWORD_REQUIRED";
        throw err;
      }
      const n = src.countPages();
      const count = this.doc.countPages();
      const pos = Math.max(0, Math.min(count, Number.isInteger(at) ? at : count));
      for (let k = 0; k < n; k++) this.doc.graftPage(pos + k, src, k);
      this._invalidateDocFonts();
      return { inserted: n, count: this.doc.countPages(), at: pos };
    } finally { src.destroy(); }
  }

  extractPages(indices) {
    const list = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < this.doc.countPages());
    if (!list.length) throw new Error("Aucune page à extraire.");
    const out = new mupdf.PDFDocument();
    try {
      list.forEach((srcIndex, k) => out.graftPage(k, this.doc, srcIndex));
      for (const key of Object.values(INFO)) {
        const value = this.doc.getMetaData(key);
        if (value) out.setMetaData(key, value);
      }
      const buffer = out.saveToBuffer("garbage=compact,compress");
      try { return buffer.asUint8Array().slice(); }
      finally { buffer.destroy(); }
    } finally { out.destroy(); }
  }

  // ---------- Formulaires ----------
  widgets(i) {
    const page = this.doc.loadPage(i);
    try {
      return page.getWidgets().map((w, id) => {
        let value = "", options = [];
        try { value = w.getValue() ?? ""; } catch {}
        try { options = w.getOptions() || []; } catch {}
        return {
          id,
          type: w.getFieldType(),
          name: w.getName() || w.getLabel() || `Champ ${id + 1}`,
          label: w.getLabel() || "",
          value,
          options,
          readOnly: w.isReadOnly(),
          multiline: w.isMultiline?.(),
          password: w.isPassword?.(),
          rect: w.getRect(),
        };
      });
    } finally { page.destroy(); }
  }

  setWidget(i, id, value) {
    const page = this.doc.loadPage(i);
    try {
      const w = page.getWidgets()[id];
      if (!w) throw new Error("Champ de formulaire introuvable.");
      if (w.isReadOnly()) throw new Error("Ce champ est en lecture seule.");
      if (w.isText()) w.setTextValue(String(value ?? ""));
      else if (w.isChoice()) w.setChoiceValue(String(value ?? ""));
      else if (w.isCheckbox() || w.isRadioButton()) {
        const on = value === true || value === "true" || value === "Yes" || value === "On";
        const currentlyOn = w.getValue() !== "Off" && w.getValue() !== "";
        if (on !== currentlyOn) w.toggle();
      } else throw new Error("Ce type de champ n’est pas encore modifiable.");
      w.update();
    } finally { page.destroy(); }
  }
}
