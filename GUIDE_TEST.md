# GUIDE DE TEST - Corrections PDF Studio v1.3.1

## Objectif
Vérifier que tous les textes du PDF `Kc.103.pdf`, y compris ceux positionnés à droite, sont maintenant modifiables.

## Prérequis
- PDF Studio version 1.3.1 ou supérieure
- Fichier `Kc.103.pdf` à tester
- Navigateur web (Chrome, Firefox, Safari, ou Edge)

## étapes de test

### Test 1 : Ouverture et vérification basique
1. Lancer PDF Studio
2. Ouvrir `Kc.103.pdf`
3. ✅ Vérifier que le document se charge sans erreur
4. ✅ Vérifier que toutes les pages sont visibles dans la barre latérale

### Test 2 : Détection des textes à gauche
1. Cliquer sur un bloc de texte aligné à gauche
2. ✅ Vérifier que le curseur devient une croix (crosshair)
3. ✅ Vérifier qu'une zone bleue apparaît autour du texte
4. ✅ Vérifier que l'éditeur de texte s'ouvre dans le panneau de droite
5. Cliquer sur "Appliquer" pour fermer l'éditeur

### Test 3 : Détection des textes à droite (CORRECTION PRINCIPALE)
1. Cliquer sur un bloc de texte aligné à droite
2. ✅ Vérifier que le curseur devient une croix (crosshair)
3. ✅ Vérifier qu'une zone bleue apparaît autour du texte
4. ✅ Vérifier que l'éditeur de texte s'ouvre dans le panneau de droite
5. ✅ Vérifier que le texte est correctement affiché dans l'éditeur
6. Cliquer sur "Appliquer" pour fermer l'éditeur

### Test 4 : Modification de texte à droite
1. Cliquer sur un bloc de texte à droite
2. Modifier le texte (ajouter ou supprimer du texte)
3. Changer la police, taille ou couleur si désiré
4. Cliquer sur "Appliquer"
5. ✅ Vérifier que le texte modifié apparaît correctement sur la page
6. ✅ Vérifier que l'alignement à droite est préservé

### Test 5 : Export et vérification de la persistance
1. Après avoir modifié un texte à droite, cliquer sur "Enregistrer"
2. ✅ Vérifier que le fichier est téléchargé avec suffixe "-modifie.pdf"
3. Ouvrir le fichier exporté dans PDF Studio
4. ✅ Vérifier que le texte modifié est toujours présent
5. ✅ Vérifier que l'alignement à droite est préservé

### Test 6 : Test avec différents blocs
Répéter les tests 3-5 avec :
- Un bloc de texte centré
- Un bloc de texte justifié
- Un bloc avec plusieurs lignes
- Un bloc avec un seul mot

## Résultats attendus

### ✅ Succès
- Tous les textes sont cliquables et éditables
- Les textes à droite sont maintenant détectés (comme les textes à gauche)
- Les modifications sont appliquées correctement
- L'alignement est préservé après modification
- L'export fonctionne et préserve les modifications

### ❌ Échec
Si un texte n'est pas cliquable :
1. Vérifier que ce n'est pas du texte dans une image (nécessite OCR)
2. Vérifier que ce n'est pas du texte scanné (nécessite OCR)
3. Noter le type de bloc et la position pour analyse

## Cas particuliers à tester

### Texte dans en-tête/pied de page
- Vérifier que les textes d'en-tête sont modifiables
- Vérifier que les textes de pied de page sont modifiables

### Texte avec numérotation
- Vérifier que les listes numérotées sont modifiables
- Vérifier que les numéros sont conservés après modification

### Texte avec tableaux
- Vérifier que le texte dans les cellules est modifiable
- Vérifier que l'alignement dans les cellules est préservé

## Commandes utiles

### Vérifier la version
```bash
cd /Volumes/Samsung\ T7/Documents/Codex/app\ s/pdfstudio
npm run check
```

### Reconstruire la version de production
```bash
npm run build
```

### Lancer les tests automatisés
```bash
npm test
```

## Rapport de test

### Informations à collecter
- Date du test : _______________
- Version de PDF Studio : _______________
- Navigateur utilisé : _______________
- Système d'exploitation : _______________

### Résultats par catégorie

| Catégorie | Attendu | Obtenu | Notes |
|-----------|---------|--------|-------|
| Textes à gauche | Modifiable | [ ] Oui [ ] Non | |
| Textes à droite | Modifiable | [ ] Oui [ ] Non | |
| Textes centrés | Modifiable | [ ] Oui [ ] Non | |
| Textes justifiés | Modifiable | [ ] Oui [ ] Non | |
| Modification | Fonctionne | [ ] Oui [ ] Non | |
| Export | Fonctionne | [ ] Oui [ ] Non | |
| Persistance | Fonctionne | [ ] Oui [ ] Non | |

### Problèmes rencontrés
Décrire tout problème rencontré :
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________

### Captures d'écran
Joindre des captures d'écran montrant :
1. Un texte à droite cliqué et éditable
2. Le texte modifié appliqué
3. Le fichier exporté réouvert avec la modification

## Support

### En cas de problème
1. Vérifier les logs de la console du navigateur (F12)
2. Vérifier que tous les fichiers sont à jour
3. Exécuter `npm run check` pour vérifier la syntaxe
4. Consulter `CORRECTIONS.md` pour les détails techniques

### Contact
Pour signaler un problème ou demander de l'aide :
- Consulter la documentation dans `CORRECTIONS.md`
- Vérifier les issues existantes dans le dépôt
- Fournir le fichier PDF problématique et les étapes de reproduction

## Notes importantes

### Ce qui a changé
- **Avant** : Certains textes à droite n'étaient pas détectés
- **Après** : Tous les textes sont maintenant détectés et modifiables

### Ce qui n'a pas changé
- Le texte dans les images nécessite toujours OCR (non implémenté)
- Les PDF scannés nécessitent OCR (non implémenté)
- L'interface et les fonctionnalités restent identiques

### Limitations connues
- Texte dans images : nécessite OCR (pas dans cette version)
- Écritures complexes (arabe, chinois) : support limité
- Polices exotiques : peuvent nécessiter substitution

---

**Version du guide** : 1.0  
**Date** : 18 novembre 2026  
**Auteur** : Kilo (pour projet Qoder)