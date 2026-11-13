// Visite virtuelle — couche navigation au-dessus de product-loader.js (add-on « Aperçu three.js »).
// Le GLB porte la mise en scène (lumières, environnement, caméra, points d'intérêt) ;
// ce fichier ajoute : vue générale, balade à hauteur d'œil avec collisions, mini-carte.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRenderer, ProductStage } from './core/product-loader.js';


const EYE = 1.65;          // hauteur des yeux (m)
const RADIUS = 0.25;       // rayon du visiteur (m) : 50 cm de large, passe les portes de 90 cm avec 20 cm de jeu
const STEP_UP = 0.35;      // marche franchissable (m)
const SPEED = 2.4;         // m/s
const SUBSTEP = 0.08;      // déplacement max par sous-pas (anti-traversée)

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas);
// décodeur Draco (géométrie compressée par l'add-on Publication GitHub) servi par le CDN de three.js
const stage = new ProductStage(renderer, { dracoPath: 'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/' });
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 3; controls.maxDistance = 90;

const $ = (id) => document.getElementById(id);
const help = $('help'), card = $('card'), cross = $('cross');
let mode = 'orbit', initial = null;
const hide = { orbit: [], always: [] }; // objets masqués en vue générale
let solids = [], floors = [];
const solidBoxes = [], floorBoxes = [];
// Collisions : la salle est faite de boîtes alignées sur les axes. Sans compression, l'export glTF garde
// 12 triangles consécutifs par boîte -> AABB exactes. Avec Draco (triangles réordonnés) ou un maillage libre :
// une boîte englobante pour un petit objet, sinon une plaque par triangle (exacte, les ouvertures restent libres).
function meshBoxes(mesh) {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry, p = g.attributes.position, idx = g.index;
  const n = idx ? idx.count : p.count, get = (i) => (idx ? idx.getX(i) : i);
  const v = new THREE.Vector3(), out = [];
  const isBox = n % 36 === 0;
  if (!isBox) return decorOrTri(mesh);
  const per = 36;
  for (let k = 0; k < n; k += per) {
    const b = new THREE.Box3();
    const corners = new Set();
    for (let j = k; j < k + per; j++) {
      v.fromBufferAttribute(p, get(j)).applyMatrix4(mesh.matrixWorld); b.expandByPoint(v);
      corners.add(v.toArray().map((c) => c.toFixed(3)).join(','));
    }
    if (isBox && corners.size !== 8) return decorOrTri(mesh);
    out.push(b);
  }
  return out;
}
// objet décoratif (plante, cadre…) : une seule boîte englobante ; grand objet libre : boîte par triangle
function decorOrTri(mesh) {
  const b = new THREE.Box3().setFromObject(mesh), sz = b.getSize(new THREE.Vector3());
  if (Math.max(sz.x, sz.y, sz.z) < 3) return [b];
  return meshBoxesTri(mesh);
}
function meshBoxesTri(mesh) {
  const g = mesh.geometry, p = g.attributes.position, idx = g.index, n = idx ? idx.count : p.count;
  const v = new THREE.Vector3(), c = new THREE.Vector3(), cells = new Map();
  if (n / 3 <= 20000) {
    // plaque par triangle, épaissie de 1 cm : exacte pour murs, sols, mobilier
    const out = [];
    for (let k = 0; k < n; k += 3) {
      const tb = new THREE.Box3();
      for (let j = k; j < k + 3; j++) { v.fromBufferAttribute(p, idx ? idx.getX(j) : j).applyMatrix4(mesh.matrixWorld); tb.expandByPoint(v); }
      out.push(tb.expandByScalar(0.005));
    }
    return out;
  }
  // très grand maillage libre : triangles regroupés par cellules de 50 cm
  for (let k = 0; k < n; k += 3) {
    const tb = new THREE.Box3();
    for (let j = k; j < k + 3; j++) { v.fromBufferAttribute(p, idx ? idx.getX(j) : j).applyMatrix4(mesh.matrixWorld); tb.expandByPoint(v); }
    tb.getCenter(c);
    const key = `${Math.floor(c.x / 0.5)},${Math.floor(c.y / 0.5)},${Math.floor(c.z / 0.5)}`;
    const cb = cells.get(key);
    if (cb) cb.union(tb); else cells.set(key, tb);
  }
  return [...cells.values()];
}
const hps = []; // { name, el, node, spec }

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- chargement
try {
  // le GLB est déjà en téléchargement depuis index.html (en parallèle de three.js)
  const buf = window.__glb ? await window.__glb : null;
  $('loadmsg').textContent = 'Préparation de la visite';
  if (buf) await stage.load(buf);
  else {
    let v = '';
    try { v = (await fetch('version.txt', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''))).trim(); } catch {}
    await stage.load('salle_des_fetes.glb' + (v ? '?v=' + encodeURIComponent(v) : ''));
  }
} catch (e) {
  $('loadmsg').textContent = 'Erreur de chargement : ' + e.message; throw e;
}
initial = stage.applyInitialView(camera, controls);
camera.far = 400; camera.near = 0.3; camera.updateProjectionMatrix();

// ---------------------------------------------------------------- éclairage cuit
// L'add-on Blender « Publication GitHub » cuit la lumière avec Cycles et l'écrit dans le GLB :
//   occlusionTexture (TEXCOORD_1) de chaque matériau = lightmap encodée v = (L / lm_scale)^(1/lm_gamma)
//   empty « __lightmap_info » (extras) = { lm_mode: 'LIGHT' | 'AO', lm_scale, lm_gamma }
// LIGHT : la lumière diffuse vient uniquement de la lightmap ; les lampes temps réel ne donnent plus que les reflets.
// AO    : la texture est une occlusion, appliquée aussi à la lumière directe.
// Aucune ombre calculée en temps réel : l'éclairage ne se règle que dans Blender.
renderer.shadowMap.enabled = false;
stage.scene.traverse((o) => { if (o.isLight) o.castShadow = false; });
stage.contact.setOptions({ opacity: 0, blur: 0, enabled: false });
let lmInfo = null;
stage.root.traverse((o) => { if (o.userData?.lm_mode && !lmInfo) lmInfo = o.userData; });
const LM_MODE = lmInfo?.lm_mode ?? 'AO';
const LM_SCALE = Number(lmInfo?.lm_scale ?? 1).toFixed(6);
const LM_GAMMA = Number(lmInfo?.lm_gamma ?? 2.2).toFixed(4);
let baked = 0;
stage.scene.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m.aoMap || m.userData.__baked) continue;
    m.userData.__baked = true;
    const inject = LM_MODE === 'LIGHT'
      ? `#ifdef USE_AOMAP
  vec3 lmL = pow( texture2D( aoMap, vAoMapUv ).rgb, vec3( ${LM_GAMMA} ) ) * ${LM_SCALE};
  reflectedLight.directDiffuse = vec3( 0.0 );          // lumière diffuse : uniquement la cuisson
  reflectedLight.indirectDiffuse = diffuseColor.rgb * lmL;
  // reflets (directSpecular) conservés : sans eux, les métaux (inox) sortiraient noirs
#endif`
      : `#ifdef USE_AOMAP
  reflectedLight.directDiffuse *= ambientOcclusion;
  reflectedLight.directSpecular *= ambientOcclusion;
#endif`;
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${inject}`);
    };
    m.customProgramCacheKey = () => `baked-${LM_MODE}`;
    m.needsUpdate = true;
    baked++;
  }
});

for (const m of stage.meshes) {
  const n = m.userData.name ?? m.parent?.userData?.name ?? m.name;
  if (/^(Plafond|Luminaires|Toiture)/.test(n)) { hide.orbit.push(m); continue; }
  if (/^(Sol_|Escaliers)/.test(n)) {
    floors.push(m);
    for (const b of meshBoxes(m)) {
      // +2 cm à l'horizontale : referme les joints entre sols voisins (arrondis de la compression Draco)
      b.min.x -= 0.02; b.max.x += 0.02; b.min.z -= 0.02; b.max.z += 0.02;
      b.isStage = /^Sol_scene/.test(n); floorBoxes.push(b);
    }
    continue;
  }
  solids.push(m);
  for (const b of meshBoxes(m)) { b.mesh = m; solidBoxes.push(b); }
}

// points d'intérêt : convention HP_Informations_<Pièce>, hp_title / hp_text
const ORDER = ['Entree', 'Salle_principale', 'Scene', 'Hall_du_bar', 'Cuisine_relais', 'Salle_annexe', 'Vestiaire', 'Sanitaires', 'Loges', 'Depot'];
const rank = (h) => { const i = ORDER.indexOf(h.spec.id); return i < 0 ? 99 : i; };
for (const [name, h] of [...stage.hotspots].sort((a, b) => rank(a[1]) - rank(b[1]))) {
  if (h.spec.type !== 'Informations') continue;
  const p = h.spec.props ?? {};
  const el = document.createElement('button');
  el.className = 'hp'; el.textContent = p.title ?? h.spec.id;
  el.onclick = (ev) => { ev.stopPropagation(); focusHotspot(hps.find((x) => x.name === name)); };
  $('hotspots').appendChild(el);
  hps.push({ name, el, node: h.node, title: p.title ?? h.spec.id, text: p.text ?? '' });
  const b = document.createElement('button');
  b.textContent = p.title ?? h.spec.id; b.onclick = () => focusHotspot(hps.find((x) => x.name === name));
  $('rooms').appendChild(b);
}
function openCard(t, txt) { card.querySelector('h2').textContent = t; card.querySelector('p').textContent = txt; card.hidden = false; }
card.querySelector('.close').onclick = () => { card.hidden = true; };

// ---------------------------------------------------------------- modes
$('mOrbit').onclick = () => setMode('orbit');
$('mWalk').onclick = () => setMode('walk');

function setMode(m) {
  mode = m;
  $('mOrbit').classList.toggle('on', m === 'orbit'); $('mWalk').classList.toggle('on', m === 'walk');
  hide.orbit.forEach((o) => { o.visible = m === 'walk'; });
  cross.hidden = m !== 'walk';
  if (m === 'orbit') {
    controls.enabled = true; camera.fov = initial.fov; camera.near = 0.3; camera.updateProjectionMatrix();
    // écran en hauteur (téléphone) : on recule la caméra pour garder toute la salle dans le cadre
    const k = Math.max(1, 1.5 / camera.aspect);
    fly(initial.target.clone().add(initial.position.clone().sub(initial.target).multiplyScalar(k)), initial.target);
    help.innerHTML = '<b>Vue générale</b> · glisser : tourner · molette / pincer : zoom · clic droit : déplacer.<br>Cliquez sur une étiquette pour la fiche de la pièce.';
  } else {
    controls.enabled = false; anim = null; camera.fov = 70; camera.near = 0.05; camera.updateProjectionMatrix();
    // la balade démarre dans la dernière zone choisie (menu, étiquette ou plan), sinon à l'entrée
    if (lastPick?.h) goRoom(lastPick.h);
    else if (lastPick) { const s = findFree(lastPick.x, lastPick.z); if (s) placeAt(s, openestYaw(s)); else goRoom(entrance(), 0); }
    else goRoom(entrance(), 0);
    help.innerHTML = '<b>Balade</b> · glisser : regarder · clic au sol : y aller · ZQSD / flèches : marcher.<br>Les murs sont infranchissables : passez par les portes.';
  }
}

// ---------------------------------------------------------------- vue générale
let anim = null;
function fly(pos, target) {
  const sp = camera.position.clone(), st = controls.target.clone(), t0 = performance.now();
  anim = (t) => {
    const k = Math.min(1, (t - t0) / 900), e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(sp, pos, e); controls.target.lerpVectors(st, target, e);
    if (k >= 1) anim = null;
  };
}
let lastPick = null; // { h } ou { x, z } : dernière zone choisie
const entrance = () => hps.find((h) => /Entr/.test(h.title)) ?? hps[0];
const isBig = (h) => /principale/i.test(h.title);
// clic sur un point d'intérêt (étiquette ou menu) : la caméra se place sur ce point
function focusHotspot(h) {
  if (!h) return;
  lastPick = { h };
  if (mode === 'walk') { goRoom(h); return; }
  const p = h.node.getWorldPosition(new THREE.Vector3());
  const target = new THREE.Vector3(p.x, Math.max(0, p.y - 1.2), p.z);
  // garde l'orientation actuelle autour de la cible, avec une plongée d'au moins 40°
  const dir = camera.position.clone().sub(controls.target).normalize();
  const flat = Math.hypot(dir.x, dir.z) || 1, minY = Math.sin(THREE.MathUtils.degToRad(40));
  if (dir.y < minY) { const k = Math.cos(Math.asin(minY)) / flat; dir.set(dir.x * k, minY, dir.z * k); }
  fly(target.clone().addScaledVector(dir, isBig(h) ? 24 : 14), target);
  openCard(h.title, h.text);
}
function goRoom(h, yawOverride) {
  if (!h) return;
  const p = h.node.getWorldPosition(new THREE.Vector3());
  if (mode === 'orbit') { focusHotspot(h); return; } else {
    let x = p.x, z = p.z;
    if (/principale/i.test(h.title)) x = 26.8;           // fond de salle, face à la scène
    const spot = findFree(x, z, p.y);
    if (!spot) return;
    const yaw = yawOverride ?? (/principale/i.test(h.title) ? Math.PI / 2 : openestYaw(spot));
    placeAt(spot, yaw);
    openCard(h.title, h.text);
  }
}

// ---------------------------------------------------------------- balade
const ray = new THREE.Raycaster();
let yaw = 0, pitch = 0, feet = 0;
const pos = new THREE.Vector3();
function applyCam() { camera.position.set(pos.x, feet + EYE, pos.z); camera.rotation.set(pitch, yaw, 0, 'YXZ'); }

// grille spatiale de 1 m : chaque test ne parcourt que les boîtes voisines
const CELL = 1;
function makeGrid(boxes) {
  const g = new Map();
  for (const b of boxes) {
    for (let i = Math.floor(b.min.x / CELL); i <= Math.floor(b.max.x / CELL); i++) {
      for (let j = Math.floor(b.min.z / CELL); j <= Math.floor(b.max.z / CELL); j++) {
        const k = i * 4096 + j; let a = g.get(k); if (!a) g.set(k, a = []); a.push(b);
      }
    }
  }
  return g;
}
function near(grid, x, z, r) {
  const out = new Set();
  for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
    for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
      const a = grid.get(i * 4096 + j); if (a) for (const b of a) out.add(b);
    }
  }
  return out;
}
const solidGrid = makeGrid(solidBoxes), floorGrid = makeGrid(floorBoxes);
// dessus du sol le plus haut sous (x,z) : plancher, marche ou scène (null hors du bâtiment)
function floorAt(x, z) {
  let best = null;
  for (const b of near(floorGrid, x, z, 0)) {
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    if (best === null || b.max.y > best) best = b.max.y;
  }
  return best;
}
// vrai si le visiteur (cylindre RADIUS, de fy+0.1 à fy+1.85) ne touche aucun solide visible
function clearAt(x, z, fy) {
  const y0 = fy + 0.1, y1 = fy + 1.85, r2 = RADIUS * RADIUS;
  for (const b of near(solidGrid, x, z, RADIUS)) {
    if (!b.mesh.visible) continue;
    if (b.max.y < y0 || b.min.y > y1) continue;
    const cx = Math.max(b.min.x, Math.min(x, b.max.x)), cz = Math.max(b.min.z, Math.min(z, b.max.z));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r2) return false;
  }
  return true;
}
// déplacement élémentaire (≤ SUBSTEP < 2×RADIUS : aucune paroi ne peut être sautée).
// Tolérance de passage : si le pas est bloqué, on glisse le long du mur, puis on essaie des
// directions inclinées (jusqu'à 70°) : le visiteur contourne les angles et s'engage dans les portes
// même en arrivant décalé ou de biais.
const STEER = [25, -25, 45, -45, 70, -70].map((d) => d * Math.PI / 180);
function tryMove(dx, dz) {
  const tries = [[dx, dz], [dx, 0], [0, dz]];
  for (const a of STEER) {
    const c = Math.cos(a), s = Math.sin(a);
    tries.push([dx * c - dz * s, dx * s + dz * c]);
  }
  const want = Math.hypot(dx, dz);
  for (let [mx, mz] of tries) {
    if (Math.abs(mx) < 1e-9) mx = 0;
    if (Math.abs(mz) < 1e-9) mz = 0;
    if (Math.hypot(mx, mz) < want * 0.2) continue;   // glissement trop court : pas une vraie avancée
    const nx = pos.x + mx, nz = pos.z + mz;
    const fy = floorAt(nx, nz);
    if (fy === null || Math.abs(fy - feet) > STEP_UP) continue;   // bord de scène : seulement par les escaliers
    if (!clearAt(nx, nz, fy)) continue;
    pos.x = nx; pos.z = nz; feet = fy; return true;
  }
  return false;
}
function move(v) {
  const n = Math.max(1, Math.ceil(v.length() / SUBSTEP));
  let moved = false;
  for (let i = 0; i < n; i++) moved = tryMove(v.x / n, v.z / n) || moved;
  return moved;
}
// cherche une position libre proche (téléportation sûre)
function findFree(x, z, yHint = 3) {
  for (let r = 0; r <= 2.5; r += 0.25) {
    const steps = r === 0 ? 1 : Math.ceil(r * 12);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const fy = floorAt(px, pz);
      if (fy !== null && clearAt(px, pz, fy)) return { x: px, z: pz, y: fy };
    }
  }
  return null;
}
// orientation vers la direction la plus dégagée (arrivée dans une pièce)
function openestYaw(s) {
  let best = 0, bestD = -1;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2, dx = -Math.sin(a), dz = -Math.cos(a);
    let d = 0;
    while (d < 15 && clearAt(s.x + dx * (d + 0.2), s.z + dz * (d + 0.2), s.y) && floorAt(s.x + dx * (d + 0.2), s.z + dz * (d + 0.2)) !== null) d += 0.2;
    if (d > bestD + 0.05) { bestD = d; best = a; }
  }
  return best;
}
function placeAt(s, yw) {
  pos.set(s.x, 0, s.z); feet = s.y; walkTarget = null;
  if (yw !== undefined) { yaw = yw; pitch = -0.04; }
  applyCam();
}

let walkTarget = null; const keys = {};
addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; });
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'walk') return;
  drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
  yaw += dx * 0.0042; pitch = Math.max(-1.3, Math.min(1.3, pitch + dy * 0.0042)); applyCam();
});
canvas.addEventListener('pointerup', (e) => {
  if (!drag) return; const click = drag.moved < 6; drag = null; if (!click) return;
  const m = new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(m, camera); ray.far = 60;
  const hit = ray.intersectObjects([...floors, ...solids.filter((s) => s.visible)], false)[0];
  if (hit && floors.includes(hit.object)) walkTarget = new THREE.Vector3(hit.point.x, 0, hit.point.z);
});

// ---------------------------------------------------------------- radar (mini-carte)
// Dessiné en vecteurs depuis la géométrie chargée : murs (Murs_*), vitrages, sols, mobilier.
// Balade : centré sur le visiteur, tourne avec son regard. Vue générale : tout le bâtiment, nord en haut.
const RAD = { css: 0, R: 0, ppm: 24 };
const mapc = $('mapc'), mx = mapc.getContext('2d'), zoneEl = $('zone');
const C = { night: '#0F0414', red: '#E00E45', mist: '237,242,247', green: '85,213,159' };
const base = (() => {
  const bb = new THREE.Box3(); floorBoxes.forEach((b) => bb.union(b)); bb.expandByScalar(1.5);
  const ppm = RAD.ppm, W = Math.ceil((bb.max.x - bb.min.x) * ppm), H = Math.ceil((bb.max.z - bb.min.z) * ppm);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const X = (x) => (x - bb.min.x) * ppm, Z = (z) => (z - bb.min.z) * ppm;
  const rect = (b) => g.fillRect(X(b.min.x), Z(b.min.z), Math.max(1, (b.max.x - b.min.x) * ppm), Math.max(1, (b.max.z - b.min.z) * ppm));
  // grille : 1 m discrète, 5 m marquée
  for (let m = Math.ceil(bb.min.x); m <= bb.max.x; m++) { g.fillStyle = `rgba(${C.mist},${m % 5 ? .035 : .08})`; g.fillRect(X(m), 0, 1, H); }
  for (let m = Math.ceil(bb.min.z); m <= bb.max.z; m++) { g.fillStyle = `rgba(${C.mist},${m % 5 ? .035 : .08})`; g.fillRect(0, Z(m), W, 1); }
  for (const b of floorBoxes) { g.fillStyle = b.isStage ? 'rgba(224,14,69,.16)' : `rgba(${C.mist},.07)`; rect(b); }
  const name = (b) => b.mesh.name;
  const furn = solidBoxes.filter((b) => !/^(Murs|Vitrages|Rideaux|Plafond|Toiture|Luminaires)/.test(name(b)) && b.max.y < 2.4);
  g.fillStyle = `rgba(${C.mist},.22)`; furn.forEach(rect);
  const walls = solidBoxes.filter((b) => /^Murs/.test(name(b)) && b.min.y < 1.2);
  g.save(); g.shadowColor = 'rgba(224,14,69,.75)'; g.shadowBlur = 7; g.fillStyle = `rgba(${C.mist},.95)`; walls.forEach(rect); g.restore();
  g.fillStyle = `rgba(${C.mist},.95)`; walls.forEach(rect);
  g.fillStyle = `rgba(${C.green},.9)`; solidBoxes.filter((b) => /^Vitrages/.test(name(b))).forEach(rect);
  return { cv, bb, ppm, W, H };
})();
const zones = hps.map((h) => { const p = h.node.getWorldPosition(new THREE.Vector3()); return { t: h.title, x: p.x, z: p.z }; });
function sizeRadar() {
  const css = mapc.clientWidth || 220, dpr = Math.min(devicePixelRatio || 1, 2);
  if (css === RAD.css) return; RAD.css = css; mapc.width = mapc.height = Math.round(css * dpr); RAD.R = mapc.width / 2;
}
// repère radar courant : centre (monde), rotation, échelle (px canvas / m)
function radarFrame() {
  const R = RAD.R;
  if (mode === 'walk') return { cx: pos.x, cz: pos.z, rot: yaw, k: R / 11 };          // ~11 m de rayon
  const w = base.bb.max.x - base.bb.min.x, h = base.bb.max.z - base.bb.min.z;
  const c = base.bb.getCenter(new THREE.Vector3());
  return { cx: c.x, cz: c.z, rot: 0, k: (R * 1.86) / Math.hypot(w, h) };
}
const toRadar = (f, x, z) => {                       // monde -> pixels canvas (origine au centre)
  const dx = (x - f.cx) * f.k, dz = (z - f.cz) * f.k, c = Math.cos(f.rot), s = Math.sin(f.rot);
  return [dx * c - dz * s, dx * s + dz * c];
};
const fromRadar = (f, u, v) => {
  const c = Math.cos(-f.rot), s = Math.sin(-f.rot);
  return [f.cx + (u * c - v * s) / f.k, f.cz + (u * s + v * c) / f.k];
};
function chevron(x, y, ang, sz) {
  mx.save(); mx.translate(x, y); mx.rotate(ang);
  mx.beginPath(); mx.moveTo(0, -sz); mx.lineTo(sz * 0.72, sz * 0.75); mx.lineTo(0, sz * 0.32); mx.lineTo(-sz * 0.72, sz * 0.75); mx.closePath();
  mx.fillStyle = C.red; mx.shadowColor = 'rgba(224,14,69,.9)'; mx.shadowBlur = sz; mx.fill();
  mx.shadowBlur = 0; mx.lineWidth = sz * 0.18; mx.strokeStyle = '#fff'; mx.stroke(); mx.restore();
}
let zoneName = '', zoneTick = -1e9;
function drawMap(t) {
  sizeRadar();
  const R = RAD.R, D = R * 2, f = radarFrame(), u = R / 110;
  mx.setTransform(1, 0, 0, 1, 0, 0); mx.clearRect(0, 0, D, D);
  // fond
  const bg = mx.createRadialGradient(R, R, R * 0.1, R, R, R);
  bg.addColorStop(0, 'rgba(32,10,40,.94)'); bg.addColorStop(1, 'rgba(15,4,20,.96)');
  mx.beginPath(); mx.arc(R, R, R - 1, 0, 7); mx.fillStyle = bg; mx.fill();
  mx.save(); mx.beginPath(); mx.arc(R, R, R - 6 * u, 0, 7); mx.clip();
  // carte
  mx.save(); mx.translate(R, R); mx.rotate(f.rot); mx.scale(f.k / base.ppm, f.k / base.ppm);
  mx.translate(-(f.cx - base.bb.min.x) * base.ppm, -(f.cz - base.bb.min.z) * base.ppm);
  mx.drawImage(base.cv, 0, 0); mx.restore();
  // balayage radar
  const sweep = (t / 2600) % 1 * Math.PI * 2;
  if (mx.createConicGradient) {
    const cg = mx.createConicGradient(sweep, R, R);
    cg.addColorStop(0, 'rgba(224,14,69,.22)'); cg.addColorStop(0.12, 'rgba(224,14,69,0)'); cg.addColorStop(1, 'rgba(224,14,69,0)');
    mx.fillStyle = cg; mx.fillRect(0, 0, D, D);
  }
  // anneaux de distance
  mx.strokeStyle = `rgba(${C.mist},.07)`; mx.lineWidth = u;
  for (const k of [0.33, 0.66]) { mx.beginPath(); mx.arc(R, R, R * k, 0, 7); mx.stroke(); }
  // noms de zones
  mx.font = `800 ${Math.round(8.5 * u)}px Archivo, sans-serif`; mx.textAlign = 'center'; mx.textBaseline = 'middle';
  for (const z of mode === 'walk' ? zones : []) {
    const [x, y] = toRadar(f, z.x, z.z);
    if (Math.hypot(x, y) > R * 0.82) continue;
    mx.fillStyle = `rgba(${C.mist},.55)`; mx.fillText(z.t.toUpperCase(), R + x, R + y + 10 * u);
  }
  // visiteur / caméra
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  let px = R, py = R, ang = 0;
  if (mode === 'walk') { ang = 0; }
  else { const [x, y] = toRadar(f, controls.target.x, controls.target.z); px = R + x; py = R + y; ang = Math.atan2(dir.x, -dir.z); }
  const coneAng = ang - Math.PI / 2, cone = mx.createRadialGradient(px, py, 0, px, py, R * 0.55);
  cone.addColorStop(0, 'rgba(224,14,69,.45)'); cone.addColorStop(1, 'rgba(224,14,69,0)');
  mx.beginPath(); mx.moveTo(px, py); mx.arc(px, py, R * 0.55, coneAng - 0.55, coneAng + 0.55); mx.closePath(); mx.fillStyle = cone; mx.fill();
  const pulse = (t / 1200) % 1;
  mx.beginPath(); mx.arc(px, py, (6 + pulse * 16) * u, 0, 7); mx.strokeStyle = `rgba(224,14,69,${0.6 * (1 - pulse)})`; mx.lineWidth = 1.5 * u; mx.stroke();
  chevron(px, py, ang, 8 * u);
  mx.restore();
  // couronne : graduations + nord
  mx.save(); mx.translate(R, R);
  mx.beginPath(); mx.arc(0, 0, R - 3 * u, 0, 7); mx.strokeStyle = `rgba(${C.mist},.18)`; mx.lineWidth = 1.2 * u; mx.stroke();
  mx.rotate(f.rot);
  for (let i = 0; i < 72; i++) {
    const a = i / 72 * Math.PI * 2, L = i % 18 === 0 ? 7 : i % 6 === 0 ? 4.5 : 2.5;
    mx.beginPath(); mx.moveTo(Math.sin(a) * (R - 3 * u), -Math.cos(a) * (R - 3 * u)); mx.lineTo(Math.sin(a) * (R - (3 + L) * u), -Math.cos(a) * (R - (3 + L) * u));
    mx.strokeStyle = i % 18 === 0 ? C.red : `rgba(${C.mist},.35)`; mx.lineWidth = (i % 18 === 0 ? 2 : 1) * u; mx.stroke();
  }
  mx.fillStyle = C.red; mx.font = `800 ${Math.round(11 * u)}px Archivo, sans-serif`; mx.textAlign = 'center'; mx.textBaseline = 'middle';
  mx.fillText('N', 0, -(R - 17 * u));
  mx.restore();
  mx.beginPath(); mx.arc(R, R, R - 0.8 * u, 0, 7); mx.strokeStyle = 'rgba(224,14,69,.85)'; mx.lineWidth = 1.6 * u; mx.stroke();
  // zone courante (recalculée 4 fois par seconde)
  if (t - zoneTick > 250) {
    zoneTick = t;
    const ref = mode === 'walk' ? pos : controls.target;
    const zn = zoneAt(ref.x, ref.z);
    if (zn !== zoneName) { zoneName = zn; zoneEl.textContent = zn; }
  }
}
// pièce = point d'intérêt le plus proche sans mur entre les deux (repli : le plus proche)
const wallBoxes = solidBoxes.filter((b) => /^Murs/.test(b.mesh.name) && b.min.y < 1.2 && b.max.y > 1.2);
function segHitsBox(x0, z0, x1, z1, b) {
  let t0 = 0, t1 = 1;
  for (const [p, d, lo, hi] of [[x0, x1 - x0, b.min.x, b.max.x], [z0, z1 - z0, b.min.z, b.max.z]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return false; continue; }
    let a = (lo - p) / d, c = (hi - p) / d; if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) return false;
  }
  return true;
}
function zoneAt(x, z) {
  let best = null, bd = 1e9, near = null, nd = 1e9;
  for (const q of zones) {
    const d = Math.hypot(q.x - x, q.z - z);
    if (d < nd) { nd = d; near = q; }
    if (d < bd && !wallBoxes.some((b) => segHitsBox(x, z, q.x, q.z, b))) { bd = d; best = q; }
  }
  return (best ?? near)?.t ?? '';
}
mapc.addEventListener('click', (e) => {
  const r = mapc.getBoundingClientRect(), dpr = mapc.width / r.width;
  const u = (e.clientX - r.left) * dpr - RAD.R, v = (e.clientY - r.top) * dpr - RAD.R;
  if (Math.hypot(u, v) > RAD.R * 0.95) return;
  const [x, z] = fromRadar(radarFrame(), u, v);
  if (mode === 'orbit') {
    lastPick = { x, z };
    const t = new THREE.Vector3(x, 0, z);
    fly(t.clone().add(new THREE.Vector3(0.5, 1, 0.75).normalize().multiplyScalar(14)), t);
  } else {
    const s = findFree(x, z, 3); if (s) placeAt(s);
  }
});

// ---------------------------------------------------------------- boucle
const timer = new THREE.Timer(), tmp = new THREE.Vector3();
let hpTick = 0;
function updateHotspots(t) {
  const check = t - hpTick > 200; if (check) hpTick = t;
  for (const h of hps) {
    h.node.getWorldPosition(tmp);
    const dist = camera.position.distanceTo(tmp);
    tmp.project(camera);
    let vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    if (mode === 'walk') {
      if (dist > 14) vis = false;
      else if (vis && check) h.occ = stage.isHotspotOccluded(h.name, camera);
      if (h.occ) vis = false;
    }
    h.el.style.display = vis ? '' : 'none';
    h.el.style.left = (tmp.x + 1) / 2 * innerWidth + 'px';
    h.el.style.top = (1 - tmp.y) / 2 * innerHeight + 'px';
  }
}
renderer.setAnimationLoop((t) => {
  timer.update(t); const dt = Math.min(timer.getDelta(), 0.05);
  if (mode === 'orbit') { if (anim) anim(t); controls.update(); }
  else {
    const fwd = (keys.z || keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
    const side = (keys.d ? 1 : 0) - (keys.q || keys.a ? 1 : 0);
    if (keys.arrowleft) yaw += 1.8 * dt;
    if (keys.arrowright) yaw -= 1.8 * dt;
    const F = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), R = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (fwd || side) {
      walkTarget = null;
      move(F.multiplyScalar(fwd).add(R.multiplyScalar(side)).normalize().multiplyScalar(SPEED * dt));
    } else if (walkTarget) {
      const v = new THREE.Vector3(walkTarget.x - pos.x, 0, walkTarget.z - pos.z), d = v.length();
      if (d < 0.25) walkTarget = null;
      else {
        const ty = Math.atan2(-v.x, -v.z); const dy = ((ty - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        yaw += dy * Math.min(1, dt * 5);
        if (!move(v.normalize().multiplyScalar(Math.min(d, SPEED * dt)))) walkTarget = null;
      }
    }
    applyCam();
  }
  updateHotspots(t);
  stage.update(dt);
  drawMap(t);
  renderer.render(stage.scene, camera);
});
setMode('orbit');
// shaders compilés en arrière-plan avant le premier affichage (pas de gel à l'apparition)
try { await renderer.compileAsync(stage.scene, camera); } catch {}
$('load').remove();
window.__viewer = { look(p) { pitch = p; applyCam(); }, get baked() { return baked; }, lmMode: LM_MODE, stage, solidBoxes, floorBoxes, camera, pos, move, placeAt, findFree, floorAt, clearAt, get feet() { return feet; }, setMode };
