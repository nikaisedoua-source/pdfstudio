# PDF Studio — livrables et robustesse

## Interface d’édition professionnelle
- [x] L’application affiche une interface française de type studio avec barre d’outils, navigation des pages, zoom et panneau contextuel.
- [x] Le panneau document regroupe métadonnées, pages, formulaire, intégrité et export dans des sections repliables.
- [ ] L’interface reste utilisable sur écran étroit avec commandes principales accessibles. Les règles responsive existent, mais le contrôle visuel dédié mobile reste à faire.

## Import, aperçu et navigation PDF
- [x] L’utilisateur peut ouvrir un PDF par sélection de fichier ou glisser-déposer; le contrôle de signature refuse les formats manifestement incorrects.
- [x] Les PDF protégés déclenchent une boîte de dialogue native; un mot de passe erroné est signalé et la saisie peut être reprise.
- [x] Le document est rendu localement dans le navigateur et la page active est navigable.
- [x] Une colonne de miniatures permet de sélectionner rapidement une page; le rendu se fait par petits lots avec une limite mémoire.

## Outils d’édition
- [x] Le texte existant est modifiable lorsqu’il est extractible par le moteur PDF.
- [x] La police d’origine embarquée est réutilisée si elle contient les glyphes saisis; sinon une substitution compatible est appliquée et signalée.
- [x] L’édition et l’ajout de texte cyrillique (russe) utilisent une police CID Unicode et sont vérifiés à l’export.
- [x] L’utilisateur peut ajouter du texte et régler police, taille, couleur, style et alignement.
- [x] Les images peuvent être ajoutées, déplacées, redimensionnées, remplacées ou supprimées.
- [x] Le texte inclus dans une image peut être masqué puis réécrit sur fond uni.
- [x] Les pages peuvent être tournées, dupliquées, supprimées, déplacées, extraites ou complétées par un autre PDF.
- [x] Les champs de formulaire (texte, case à cocher, liste déroulante) sont détectés, remplis et conservés à l’export.
- [x] Les métadonnées (titre, auteur, sujet, mots-clés) sont éditables sans perdre les autres champs.

## Fiabilité et export
- [x] Annuler/rétablir et raccourcis clavier protègent les manipulations; les commits sont restaurés à partir d’un instantané en cas d’erreur.
- [x] L’export fidélité conserve les objets référencés, les pièces jointes, les métadonnées et le chiffrement, tout en retirant les flux devenus inaccessibles pour ne pas laisser de texte supprimé dans le fichier.
- [x] L’export compact compacte et renumérote les objets; il conserve lui aussi métadonnées, pièces jointes et chiffrement.
- [x] Un PDF protégé exporté reste protégé : la réouverture sans mot de passe est refusée, la réouverture avec le mot de passe fonctionne.
- [x] Le PDF modifié est exporté par téléchargement local avec un nom explicite; l’original n’est jamais écrasé.
- [x] Les états de chargement, erreur et succès sont compréhensibles sans quitter l’espace de travail.
- [x] Les changements non enregistrés sont signalés avant de remplacer le document ou de fermer la page.

## Protections et ressources
- [x] L’import refuse les fichiers dépassant 200 Mio et avertit à partir de 80 Mio; le type de fichier est corroboré par la signature PDF.
- [x] Les images sont limitées à 40 Mio et 32 mégapixels, normalisées en PNG et décodées en gérant leurs métadonnées d’orientation.
- [x] Le rendu MuPDF est plafonné à 16 millions de pixels et 10 000 pixels par côté; l’historique est limité à 256 Mio.
- [x] Le service worker utilise un cache versionné propre à PDF Studio et ne supprime pas les caches d’autres applications sur la même origine.
- [x] Les lanceurs locaux écoutent sur 127.0.0.1; une CSP limite les ressources au projet et autorise le WASM requis.
- [x] `npm run check` valide la syntaxe, exécute les tests d’intégration MuPDF et construit le dossier `dist/`.

## Vérifications effectuées
- [x] PDF réel `Kc.102.pdf` : six objets de texte extractibles traduits en russe, export réouvert et vérifié.
- [x] PDF chiffré RC4-128 : mot de passe erroné refusé, mot de passe correct accepté, export toujours chiffré et réouvert avec le mot de passe.
- [x] Formulaire de test : champ détecté, valeur saisie depuis l’interface, export réouvert avec la valeur.
- [x] Contrôle anti-fuite : après remplacement d’un titre, l’ancien texte n’apparaît plus dans le flux du fichier exporté.
- [x] Parcours navigateur : métadonnées, police d’origine, substitution cyrillique, rotation, duplication, annulation et export.

## À faire
- [ ] Exécuter MuPDF dans un Web Worker pour éviter que l’analyse et le rendu de PDF volumineux bloquent le fil principal.
- [ ] Ajouter des tests dédiés sur écrans mobiles, scans sans texte extractible et pages de dimensions inhabituelles.
- [x] Ajouter OCR/retouche de texte pour les textes incorporés à des images. Sur `Kc.102.pdf`, le texte de l’affiche à droite et de la capture de téléphone reste français car il est aplati dans les images. → **FAIT en v1.3.1** : OCR Tesseract local (fra/eng/rus) intégré à l’outil « Retoucher une image » ; **retouche en une étape** (tracé → éditeur + OCR pré-rempli). **Éditeur « façon Photoshop »** : cadre à poignée ✥ (déplacement) + 6 poignées (coins = taille de police, ouest/est = largeur), et **glisser-déposer d’images**. `Kc.100.pdf` est 100 % images (0 texte réel) et se modifie par masquer + réécrire. Voir `CORRECTIONS_OCR.md`.
- [ ] Créer ou modifier la structure des formulaires (ajout de champs); la version actuelle les remplit seulement.
