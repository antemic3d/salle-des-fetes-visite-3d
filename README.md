# Salle des fêtes — visite virtuelle 3D (démo)

Visionneuse web de la salle des fêtes, modélisée dans Blender d'après le plan et exportée avec l'add-on « Aperçu three.js ».

- **Vue générale** : maquette sans plafond, fiches des pièces.
- **Balade** : visite à hauteur d'œil, murs et mobilier infranchissables, mini-carte cliquable.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | page et interface |
| `app.js` | navigation (vue générale, balade, collisions, mini-carte) |
| `core/product-loader.js` | module de référence de l'add-on (inchangé) |
| `salle_des_fetes.glb` | scène exportée depuis Blender (« Exporter le GLB final ») |
| `version.txt` | identifiant de la dernière publication (anti-cache) |
| `plan.jpg` | plan utilisé par la mini-carte |

## Mettre à jour la scène

1. Modifier `salle_des_fetes.blend` dans Blender.
2. Panneau Aperçu Web > « Exporter le GLB final » vers `salle_des_fetes.glb`.
3. Remplacer le fichier dans ce dépôt et pousser.

## Intégrer sur un site

```html
<iframe src="https://<compte>.github.io/<depot>/" style="width:100%;height:80vh;border:0" allowfullscreen></iframe>
```

Dépendance chargée depuis le CDN jsDelivr : three.js r186.

## Ombres cuites

L'add-on Blender « Publication GitHub » (≥ 0.3) cuit l'occlusion ambiante de chaque objet avec Cycles
avant chaque publication et l'écrit comme `occlusionTexture` glTF (UV « LightmapUV », TEXCOORD_1).
La visionneuse l'applique à toute la lumière (directe comprise). Sans ombres cuites, elle se rabat sur
une occlusion calculée à l'écran (GTAO, bouton « Ombres »).
