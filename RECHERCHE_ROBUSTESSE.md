# Recherche et renforcement de PDF Studio

PDF Studio traite des PDF locaux avec MuPDF.js/WebAssembly. Les recommandations les plus utiles pour cette architecture portent sur l’exécution du travail lourd, la validation en couches des fichiers, la maîtrise des ressources mémoire et l’isolation du cache hors ligne.

## Ce que la recherche indique

La documentation MuPDF.js présente un visualiseur web officiel où MuPDF tourne dans un Web Worker, afin que le travail lourd se fasse sur un fil d’arrière-plan; les pages sont rendues au fur et à mesure qu’elles deviennent nécessaires [1]. PDF Studio exécute actuellement MuPDF sur le fil principal. Le rendu plafonné et la génération des miniatures par petits lots limitent le coût, mais ne suppriment pas le risque de gel pendant l’analyse d’un PDF complexe. Le Web Worker est le prochain chantier structurel recommandé; l’intégrer proprement demandera une interface RPC et des règles explicites pour transférer ou conserver les objets MuPDF non sérialisables.

OWASP recommande de ne pas faire confiance au nom de fichier ou au type MIME déclaré et de combiner plusieurs contrôles. La signature du fichier est utile, mais OWASP précise qu’elle ne doit pas être utilisée seule [2]. Comme PDF Studio ne téléverse aucun document vers un serveur, les mesures ajoutées visent surtout à refuser les formats accidentels et à protéger la mémoire du navigateur. Elles ne constituent ni un antivirus ni une garantie contre un PDF malveillant.

`createImageBitmap()` est asynchrone et renvoie une promesse contenant un `ImageBitmap`; la documentation décrit aussi la prise en compte de l’orientation issue des métadonnées d’image [3]. Le nouvel import d’image gère les erreurs de décodage, vérifie les dimensions avant de créer le canevas, normalise le résultat en PNG et ferme le bitmap après conversion. Cela évite d’utiliser des dimensions orientées d’une manière différente du fichier JPEG original.

Le service worker est un proxy contrôlé par l’application. MDN explique que l’installation attend la réussite des ressources ajoutées avec `addAll()`, et que l’activation sert notamment à retirer les caches obsolètes [4]. L’ancien code supprimait tous les caches différents de son cache courant sur l’origine entière. La nouvelle version ne nettoie que les caches préfixés `pdfstudio-`, ajoute un secours de navigation vers l’application hors ligne et n’inscrit pas les PDF dans le précache.

## Modifications appliquées

L’import limite les PDF à 200 Mio, avertit au-delà de 80 Mio et cherche l’en-tête `%PDF-` dans les 1 024 premiers octets. Il refuse les fichiers sans signature reconnaissable avant de les remettre à MuPDF. Les erreurs de lecture ou d’ouverture sont affichées sans remplacer intentionnellement le document courant lorsque la validation préliminaire échoue.

Le rendu est plafonné à 16 millions de pixels et à 10 000 pixels par côté, y compris dans le moteur MuPDF lui-même. Les miniatures sont calculées par petits lots et réduites selon les dimensions de la page. Les images importées sont plafonnées à 40 Mio et 32 mégapixels. L’historique conserve au plus 12 étapes et 256 Mio d’instantanés; les plus anciennes étapes sont évincées quand le plafond est atteint.

Les modifications sont sauvegardées en mémoire avant application afin de permettre une restauration en cas d’erreur. L’application distingue maintenant l’état enregistré de l’état modifié, avertit avant le remplacement d’un document et utilise l’avertissement standard du navigateur avant fermeture. Le téléchargement produit une copie au nom nettoyé, sans écraser l’original.

La politique CSP autorise les scripts du projet et le mécanisme WASM requis par MuPDF, tout en refusant les objets embarqués et les connexions vers des origines tierces. Les lanceurs Windows et Mac/Linux écoutent sur `127.0.0.1`. Les limites de sécurité annoncées dans l’interface et le guide sont explicites.

### Support du texte cyrillique

La documentation MuPDF.js distingue `addSimpleFont` (polices à encodage 8 bits Latin/Greek/Cyrillic) et `addFont`, qui crée une police CID encodée en Identity-H [5]. Le moteur choisit maintenant ce dernier chemin lorsque le texte contient des caractères hors du jeu Latin utilisé par l’ancien export, convertit les caractères en identifiants de glyphes avec la police embarquée et échoue explicitement si un glyphe manque. Le test d’intégration vérifie l’aller-retour d’une phrase russe dans un PDF exporté; cela évite la corruption silencieuse en « ? ».

Sur le PDF `Kc.102.pdf` fourni ensuite, le moteur a remplacé les six objets textuels sélectionnables par du russe et l’export reste lisible. Le grand visuel de droite, le texte visible à l’intérieur des images et la capture d’écran du téléphone sont des images aplaties; leur texte français n’est donc pas modifié par cette opération. Les QR codes et les illustrations sont restés en place.

### Fidélité de l’export et suppression réelle du texte

MuPDF propose plusieurs stratégies de sauvegarde : `garbage=no` conserve tous les objets, y compris les anciens flux de contenu devenus inaccessibles; `garbage=yes` supprime les objets non référencés; `garbage=compact,compress` compacte, renumérote et compresse [5]. La première version exportait la fidélité avec `garbage=no`. Un contrôle empirique a montré que l’ancien titre restait présent trois fois dans le fichier décompressé : une fois dans le flux actif et deux fois dans des flux orphelins. Un lecteur ne l’affiche pas, mais un outil d’extraction peut encore le retrouver, ce qui est inacceptable pour une modification présentée comme fidèle. L’export fidélité utilise désormais `garbage=yes` : tous les objets encore référencés — polices embarquées, images, pièces jointes, métadonnées, formulaire, annotations — sont conservés, tandis que les flux orphelins disparaissent. Le test compte les occurrences du titre remplacé dans le fichier décompressé et exige qu’il n’en reste aucune sur la page éditée. L’instantané interne utilisé pour annuler/rétablir continue d’employer `garbage=no`, car il doit préserver l’état exact avant modification.

### Chiffrement, formulaires et opérations de pages

Les documents chiffrés sont ouverts via `needsPassword`/`authenticatePassword`; le mot de passe est conservé uniquement en mémoire pour la session et réutilisé lors des réouvertures internes (annulation, duplication, export compact). Un export d’un document déverrouillé reste chiffré : MuPDF réapplique le chiffrement d’origine, et la réouverture sans mot de passe échoue correctement. L’interface ne tente jamais de casser le chiffrement et ne stocke pas le mot de passe sur disque.

Les champs AcroForm sont lus avec `getWidgets()` et `getFieldType()`; l’application gère les champs texte, les cases à cocher et les listes déroulantes, puis appelle `update()` avant l’export. Les opérations de pages s’appuient sur `rearrangePages`, `graftPage`, `deletePage` et `extractPages`; les index manipulés par le moteur sont ceux des pages (0 = première page), ce qui a été corrigé après un premier essai où la page « 1 » avait été interprétée comme un numéro d’objet.

## Vérification effectuée

`npm run check` réussit : la syntaxe des fichiers JavaScript est valide, le test d’intégration s’exécute et le build statique crée `dist/`. Le test couvre la validation de signature, l’ouverture d’un PDF de trois pages, l’extraction du texte, la détection et la suppression d’une image, le rendu raster, le remplacement et l’ajout de texte latin/cyrillique, la réutilisation de la police d’origine, l’absence de texte résiduel après remplacement, les métadonnées, les pièces jointes, les opérations de pages, les formulaires, le chiffrement et la réouverture des exports.

Le parcours navigateur a été exercé sur la fixture et sur `Kc.102.pdf` : l’application ouvre le document réel d’une page, affiche ses zones de texte et son aperçu, accepte une phrase russe saisie depuis l’interface et garde le PDF hors du cache hors ligne. Les parcours métadonnées, rotation/duplication/annulation, remplissage de formulaire et export ont été vérifiés dans le navigateur, y compris la réouverture de l’export par un moteur vierge. Sur un PDF chiffré en RC4-128, la boîte de dialogue refuse un mot de passe erroné, accepte le bon, puis l’export reste chiffré et ne s’ouvre pas sans mot de passe.

La première archive jointe contenait seulement le code; le PDF `Kc.102.pdf` a été fourni ensuite. Les cas PDF endommagés, très volumineux, scannés, à polices inhabituelles ou à pages extrêmes restent à vérifier séparément. Le moteur MuPDF est distribué sous AGPL-3.0 selon les mentions du projet; les obligations applicables doivent être conservées si l’application est redistribuée ou commercialisée.

## Références

[1]: https://mupdfjs.readthedocs.io/en/latest/apps/client-side/vanilla.html "Vanilla client-side app - MuPDF.js documentation"
[2]: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html "File Upload Cheat Sheet - OWASP"
[3]: https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap "Window.createImageBitmap - MDN"
[4]: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers "Using Service Workers - MDN"
[5]: https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFDocument.html "PDFDocument.addFont / addSimpleFont - MuPDF.js"
