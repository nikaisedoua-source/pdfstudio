// Reconnaissance optique de caractères (Tesseract.js, local, hors ligne).
// Le moteur et les données de langue (fra/eng/rus) sont embarqués dans vendor/tesseract.
// Chargé paresseusement : aucun coût tant que l'utilisateur n'a pas demandé d'OCR.

let modPromise = null;
let worker = null;
let workerLang = null;

async function loadTesseract() {
  if (!modPromise) modPromise = import("./vendor/tesseract/tesseract.min.js");
  await modPromise;
  // Le bundle UMD expose Tesseract sur l'objet global (self/window).
  return globalThis.Tesseract;
}

export function ocrSupported() {
  return true;
}

async function getWorker(lang) {
  const T = await loadTesseract();
  if (!T || typeof T.createWorker !== "function") throw new Error("Moteur OCR indisponible.");
  if (worker && workerLang === lang) return worker;
  if (worker) { try { await worker.terminate(); } catch {} worker = null; workerLang = null; }
  worker = await T.createWorker(lang, 1, {
    workerPath: "vendor/tesseract/worker.min.js",
    corePath: "vendor/tesseract",
    langPath: "vendor/tesseract/lang",
    workerBlobURL: false,
    logger: () => {},
  });
  workerLang = lang;
  return worker;
}

/**
 * Reconnaît le texte d'un canevas (image) dans la langue donnée.
 * @param {HTMLCanvasElement} canvas
 * @param {string} lang fra | eng | rus
 * @returns {Promise<{text:string, confidence:number}>}
 */
export async function recognize(canvas, lang = "fra") {
  const w = await getWorker(lang);
  const { data } = await w.recognize(canvas);
  const text = String(data?.text || "").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
  return { text, confidence: Number(data?.confidence) || 0 };
}

export async function terminateOcr() {
  if (worker) { try { await worker.terminate(); } catch {} worker = null; workerLang = null; }
}