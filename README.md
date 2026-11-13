# Salle des fêtes — visite virtuelle 3D (démo)

Visionneuse web de la salle des fêtes, modélisée dans Blender d'après le plan et exportée avec l'add-on « Aperçu three.js ».

- **Vue générale** : maquette sans plafond, fiches des pièces.
- **Balade** : visite à hauteur d'œil, murs et mobilier infranchissables, radar de navigation cliquable.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | page et interface |
| `app.js` | navigation (vue générale, balade, collisions, mini-carte) |
| `core/product-loader.js` | module de référence de l'add-on (inchangé) |
| `salle_des_fetes.glb` | scène exportée depuis Blender (« Exporter le GLB final ») |
| `version.txt` | identifiant de la dernière publication (anti-cache) |
| `plan.jpg` | plan d'origine (le radar est dessiné depuis la géométrie) |

## Mettre à jour la scène

1. Modifier `salle_des_fetes.blend` dans Blender.
2. Panneau Aperçu Web > « Exporter le GLB final » vers `salle_des_fetes.glb`.
3. Remplacer le fichier dans ce dépôt et pousser.

## Intégrer sur un site

```html
<iframe src="https://<compte>.github.io/<depot>/" style="width:100%;height:80vh;border:0" allowfullscreen></iframe>
```

Dépendance chargée depuis le CDN jsDelivr : three.js r186.

## Éclairage cuit

L'add-on Blender « Publication GitHub » (≥ 0.4) cuit l'éclairage avec Cycles avant chaque publication
(mode « Éclairage complet » : soleil, lampes, ciel, rebonds ; ou « Ombres de contact seules »).
Le résultat est écrit dans le GLB web comme `occlusionTexture` glTF (UV « LightmapUV », TEXCOORD_1),
encodé `v = (L / lm_scale)^(1/lm_gamma)` ; l'empty `__lightmap_info` porte `lm_mode`, `lm_scale`, `lm_gamma`.
La visionneuse remplace la lumière diffuse temps réel par la lumière cuite et ne calcule aucune ombre :
l'éclairage se règle uniquement dans Blender.
