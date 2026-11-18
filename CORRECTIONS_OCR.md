# CORRECTION — Textes de droite non modifiables (OCR)

## Symptôme
Dans `Kc.102.pdf` / `Kc.103.pdf`, les textes du **panneau de droite** (affiche du
prophète, rouleau, sous-titres, etc.) ne sont pas modifiables : cliquer dessus ne
sélectionne rien, ou sélectionne l’image entière.

## Cause racine (vérifiée, pas supposée)
Le texte de droite **n’est pas du texte**. C’est l’image **IMG3** (affiche aplatie en
pixels), qui couvre tout le côté droit de la page :

- `Kc.103.pdf`, page 1 (842×595 pt) : `IMG3` occupe `x 448→825`, `y 24→575`.
- Les seules « unités de texte » à droite (x > 420) sont **vides** (largeur 2–5 pt,
  texte `""`) : ce sont des artefacts, pas des glyphes.
- L’ordre de peinture du flux de contenu confirme : l’image est dessinée, puis le peu
  de texte réel par-dessus.

Il n’y a donc **aucun objet texte à cliquer** à droite. Ce n’était pas un bug de
hit-testing : il n’y avait rien à sélectionner. (Le moteur savait déjà remplacer du
texte réel — prouvé par test : l’édition d’une unité de droite de `Kc.102-english.pdf`
supprime l’ancien texte et écrit le nouveau, sans fuite.)

## Solution
Brancher **Tesseract.js (OCR)**, déjà présent dans `vendor/tesseract/` mais jamais
utilisé, et **compléter les données de langue manquantes** (le dossier `lang/` était
vide).

L’outil **« Retoucher une image »** trace un rectangle sur le texte de l’image :
1. l’utilisateur **trace** un rectangle (rubber-band) ;
2. il **ajuste** la zone avec **8 poignées de redimensionnement** (déplacement + coins/bords)
   et **confirme** (« ✓ Appliquer », ou `Ctrl/⌘+Entrée`) ou **annule** (« ✕ Annuler », ou `Échap`) ;
3. la zone confirmée est rendue à ~300 dpi et **reconnue par OCR** (pré-remplissage du champ) ;
4. l’utilisateur corrige/traduit le texte reconnu ;
5. « Appliquer » masque la zone (fond échantillonné) et réécrit le texte par-dessus.

### Fichiers ajoutés / modifiés
| Fichier | Rôle |
|---|---|
| `ocr.js` | **Nouveau.** Chargement paresseux de Tesseract, worker local, `recognize(canvas, lang)`. |
| `vendor/tesseract/lang/{fra,eng,rus}.traineddata.gz` | **Nouveau.** Données de langue (téléchargées depuis `@tesseract.js-data`). |
| `app.js` | Import de `ocr.js` ; `renderRect()` (rendu haute densité d’un rectangle) ; `ocrInto()` (OCR + pré-remplissage) ; branché sur l’outil `patch` ; sélecteur de langue + bouton « Reconnaître (OCR) » dans le panneau. |
| `index.html` | CSP : ajout de `worker-src 'self' blob:` (requis par le worker Tesseract). |
| `sw.js` | Ajout de `ocr.js` au précache ; **cache runtime** des requêtes GET same-origin (l’OCR est ainsi disponible hors ligne après une 1re utilisation). Version de cache → `v8`. |
| `package.json` | `ocr.js` ajouté au `build` ; version → `1.3.1`. |

## Pourquoi ces choix
- **Worker local + `workerBlobURL:false`** : évite le blob `blob:` pour le worker et
  permet de servir `worker.min.js` / cœur WASM / `lang` depuis le même origine (compatible
  CSP stricte `default-src 'self'`).
- **Données embarquées (pas de CDN)** : la CSP (`connect-src 'self'`) interdit tout appel
  réseau externe ; le mode hors ligne est préservé.
- **Cache runtime (pas de précache des ~13 Mo d’OCR)** : garde l’installation légère ;
  l’OCR est mis en cache à la 1re utilisation puis fonctionne hors ligne.

## Validation effectuée (navigateur réel, Chrome headless, sous la CSP de l’app)
1. `ocr.js` seul, sous CSP : lit « LE LIVRE DU PROPHÈTE KACOU PHILIPPE »,
   « KACOU 103 : DISPENSATION PROPHETIQUE », etc.
2. **Plein flux** (engine + ocr) : OCR d’une zone de droite → `fillRect` (masque) →
   `drawText` (nouveau texte) → export → réouverture → **nouveau texte présent**
   (`replacedPresent: true`), 37 unités, aucune fuite.
3. **Rectangle serré** autour du titre : « RE DU PROPHÈTE KACOU PHILIPPE » (confiance 60 %).
   → Plus l’utilisateur trace serré autour du texte, meilleure est la reconnaissance.
4. `npm run check` : syntaxe + tests + build OK.

## Limites / notes
- La reconnaissance est **laide sur les zones très graphiques** (photos, étoiles) : c’est
  attendu. Tracer **serré** autour du texte donne de bons résultats.
- Langues disponibles : `fra`, `eng`, `rus` (sélecteur dans le panneau). Pour en ajouter,
  déposer `xx.traineddata.gz` dans `vendor/tesseract/lang/` et ajouter l’option au sélecteur.
- Le texte remplacé est réécrit avec une police de substitution (Liberation…), pas la
  police d’origine (polices du poster non embarquées comme texte).
- Le masque échantillonne la couleur du fond autour du rectangle ; sur fond dégradé ou
  texturé, ajuster « Couleur du fond (masque) » dans le panneau.

## Pour les prochains développeurs
- Le point d’entrée OCR est `ocr.js` → `recognize(canvas, lang)`.
- Le point d’intégration UI est dans `app.js` : `startRubber()` (tracé) →
  `drawPatchSelection()` (sélection redimensionnable + barre d’actions) →
  `applyPatchRect()` (masque + éditeur) → `ocrInto(rect, token)` (OCR + pré-remplissage).
  Le handler `pointerdown` de l’overlay route l’outil `patch` vers `startRubber`.
- Ne **pas** re-télécharger les `traineddata` à chaque build : ils sont versionnés dans
  `vendor/tesseract/lang/`.
- Après modif de `sw.js`, incrémenter `CACHE` (`v8` → `v9`…) pour forcer la mise à jour.