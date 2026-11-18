import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as mupdf from "../vendor/mupdf.js";
import { Engine } from "../engine.js";

const root = new URL("../", import.meta.url);
const fixture = new Uint8Array(await readFile(new URL("./fixtures/smoke.pdf", import.meta.url)));
const loadFont = async (filename) => new Uint8Array(await readFile(new URL(`fonts/${filename}`, root)));
const engine = new Engine(loadFont);
const openCopy = (bytes, password) => { const e = new Engine(loadFont); e.open(bytes, password); return e; };
const textOf = (e, page) => e.model(page).units.map((unit) => unit.paras.join(" ")).join(" ");

function buildFormPdf() {
  const content = "BT /F1 18 Tf 72 700 Td (Formulaire de test) Tj ET";
  const objects = [
    null,
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 8 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [7 0 R 9 0 R 10 0 R] >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /FT /Tx /T (nom) /V () /Kids [7 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (nom) /Rect [72 600 300 630] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) /Parent 6 0 R >>",
    "<< /Fields [6 0 R 11 0 R 10 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 5 0 R >> >> >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (accord) /Rect [72 550 92 570] /P 3 0 R /F 4 /V /Off /AS /Off /AP << /N << /Off 12 0 R /Yes 13 0 R >> >> /Parent 11 0 R >>",
    "<< /Type /Annot /Subtype /Widget /FT /Ch /T (choix) /Rect [72 500 250 525] /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g) /Opt [(Alpha) (Beta) (Gamma)] /V (Alpha) /Ff 131072 >>",
    "<< /FT /Btn /T (accord) /V /Off /Kids [9 0 R] >>",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 0 >>\nstream\n\nendstream",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n", offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

assert.throws(() => new Engine(loadFont).open(new TextEncoder().encode("not a PDF")), /signature/i);
assert.equal(engine.open(fixture), 3, "opens a three-page PDF");
assert.deepEqual(engine.pageSize(0), { w: 612, h: 792 });

const pageOne = engine.model(0);
const title = pageOne.units.find((unit) => unit.paras.join(" ").includes("PDFStudio smoke test"));
assert(title, "finds the page title");
assert(pageOne.fonts.length >= 2, "lists document fonts");
assert.equal(engine.model(1).images.length, 1, "detects the embedded test image");

const replacement = await engine.replaceText(0, title, {
  text: "Replacement verification", family: "sans", size: 18,
  color: [0, 0, 0], bold: true, italic: false, align: "left", pitch: title.pitch,
});
assert.equal(replacement.fidelity, "original", "reuses the embedded document font");
assert(textOf(engine, 0).includes("Replacement verification"), "replaces the title");
assert(!textOf(engine, 0).includes("PDFStudio smoke test"), "removes only the edited text");
assert(textOf(engine, 0).includes("This document tests local PDF rendering"), "preserves the surrounding body text");

await engine.drawText(0, {
  x: 70, y: 620, text: "Local export check — Привет, мир!", family: "sans", size: 14,
  color: [0, 0, 0], bold: false, italic: false, align: "left",
});

const exported = engine.save("fidelity");
assert(exported.length > 1000, "exports a non-empty PDF");
assert(new TextDecoder("ascii").decode(exported.subarray(0, 8)).includes("%PDF-"));
const reopened = openCopy(exported);
assert.equal(reopened.pageCount(), 3, "exported PDF remains readable");
const exportedText = textOf(reopened, 0);
assert(exportedText.includes("Replacement verification"), "export preserves replacement text");
assert(exportedText.includes("Local export check — Привет, мир!"), "export preserves added Latin and Cyrillic text");
assert(!exportedText.includes("PDFStudio smoke test"), "replacement removes the original text");

// Un contenu remplacé ne doit pas rester dans un flux inaccessibles du fichier exporté.
{
  const doc = mupdf.PDFDocument.openDocument(exported, "application/pdf");
  const buffer = doc.saveToBuffer("garbage=no,decompress");
  const raw = Buffer.from(buffer.asUint8Array()).toString("latin1");
  buffer.destroy(); doc.destroy();
  let occurrences = 0;
  for (let at = 0; ;) { const hit = raw.indexOf("PDFStudio smoke test", at); if (hit < 0) break; occurrences++; at = hit + 1; }
  assert.equal(occurrences, 2, "the edited title is not retained in an unreachable stream (only pages 2 and 3 remain)");
}

// Métadonnées, pièces jointes et export compact.
engine.setMetadata({ title: "Rapport préservé", author: "Équipe PDF", subject: "Fidélité", keywords: "pdf,local" });
const ref = engine.doc.addEmbeddedFile("note.txt", "text/plain", new TextEncoder().encode("bonjour"), new Date("2026-01-01"), new Date("2026-01-02"));
engine.doc.insertEmbeddedFile("note.txt", ref);
for (const mode of ["fidelity", "compact"]) {
  const out = engine.save(mode);
  const copy = openCopy(out);
  assert.equal(copy.metadata().title, "Rapport préservé", `metadata preserved in ${mode} export`);
  assert.equal(copy.metadata().author, "Équipe PDF");
  assert.deepEqual(copy.attachments(), ["note.txt"], `attachment preserved in ${mode} export`);
  copy.doc.destroy();
}

const preview = engine.render(0, 0.5);
assert(preview.width > 0 && preview.height > 0, "renders page pixels");
assert.equal(preview.pixels.length, preview.width * preview.height * 4);

// Pages : rotation, duplication, déplacement, suppression, insertion et extraction.
const pages = openCopy(fixture);
assert.equal(pages.rotatePage(0, 90), 90, "rotates a page");
assert.equal(pages.pageInfo(0).rotation, 90);
assert.equal(pages.duplicatePage(0), 4, "duplicates a page");
assert.equal(pages.deletePage(1), 3, "deletes a page");
assert.equal(pages.movePage(0, 2), 3, "moves a page");
assert.equal(pages.insertPages(fixture, 1).count, 6, "inserts pages from another PDF");
const extracted = openCopy(pages.extractPages([2]));
assert.equal(extracted.pageCount(), 1, "extracts one page");
assert(textOf(extracted, 0).includes("PDFStudio smoke test"), "extracted page keeps content");
extracted.doc.destroy(); pages.doc.destroy();

// Formulaire AcroForm : détection, saisie et persistance (texte, case, liste).
{
  const form = openCopy(buildFormPdf());
  const fields = form.widgets(0);
  assert.equal(fields.length, 3, "detects all form widgets");
  assert.deepEqual(fields.map((f) => f.type), ["text", "checkbox", "combobox"]);
  form.setWidget(0, 0, "Jean Dupont");
  form.setWidget(0, 1, true);
  form.setWidget(0, 2, "Beta");
  const out = form.save("fidelity");
  const copy = openCopy(out);
  const persisted = copy.widgets(0);
  assert.equal(persisted[0].value, "Jean Dupont", "text value persists through fidelity export");
  assert.notEqual(persisted[1].value, "Off", "checkbox state persists through fidelity export");
  assert.equal(persisted[2].value, "Beta", "choice value persists through fidelity export");
  copy.doc.destroy(); form.doc.destroy();
}

// PDF chiffré : mot de passe requis, export toujours protégé.
{
  const source = openCopy(fixture);
  const buffer = source.doc.saveToBuffer("garbage=no,encrypt=rc4-128,user-password=secret,owner-password=secret");
  const encrypted = buffer.asUint8Array().slice();
  buffer.destroy(); source.doc.destroy();
  let code = null;
  try { new Engine(loadFont).open(encrypted); } catch (e) { code = e.code; }
  assert.equal(code, "PASSWORD_REQUIRED", "encrypted PDF requires a password");
  const unlocked = openCopy(encrypted, "secret");
  assert.equal(unlocked.pageCount(), 3);
  const reexported = unlocked.save("fidelity");
  assert.throws(() => new Engine(loadFont).open(reexported), /mot de passe/i, "fidelity export keeps encryption");
  const again = openCopy(reexported, "secret");
  assert.equal(again.pageCount(), 3, "fidelity export opens with the same password");
  again.doc.destroy(); unlocked.doc.destroy();
}

// Suppression d'image.
{
  const images = openCopy(fixture);
  const pageTwoImages = images.model(1).images;
  images.deleteImage(1, pageTwoImages[0], pageTwoImages);
  assert.equal(images.model(1).images.length, 0, "removes an embedded image");
  images.doc.destroy();
}

engine.doc?.destroy();
reopened.doc?.destroy();
console.log("PDFStudio smoke test passed: validation, fidelity fonts/redaction, leak-free export, metadata, attachments, compact export, raster render, page operations, forms, encryption, text/image editing.");
