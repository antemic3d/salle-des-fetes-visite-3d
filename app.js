// Visite virtuelle — couche navigation au-dessus de product-loader.js (add-on « Aperçu three.js »).
// Le GLB porte la mise en scène (lumières, environnement, caméra, points d'intérêt) ;
// ce fichier ajoute : vue générale, balade à hauteur d'œil avec collisions, mini-carte.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createRenderer, ProductStage } from './core/product-loader.js';


const EYE = 1.65;          // hauteur des yeux (m)
const RADIUS = 0.35;       // rayon du visiteur (m)
const STEP_UP = 0.35;      // marche franchissable (m)
const SPEED = 2.4;         // m/s
const SUBSTEP = 0.08;      // déplacement max par sous-pas (anti-traversée)
// mini-carte : cm du plan -> pixels de plan.jpg
const OX = 23, OY = 18, S = 0.2455;

const canvas = document.getElementById('view');
const renderer = createRenderer(canvas);
const stage = new ProductStage(renderer);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 3; controls.maxDistance = 90;

const $ = (id) => document.getElementById(id);
const help = $('help'), card = $('card'), cross = $('cross');
let mode = 'orbit', initial = null;
const hide = { orbit: [], always: [] }; // objets masqués en vue générale
let furniture = [], solids = [], floors = [];
const solidBoxes = [], floorBoxes = [];
// La salle est faite de boîtes alignées sur les axes : l'export glTF garde
// 12 triangles consécutifs par boîte. On en tire des AABB exactes pour les collisions.
// Si un maillage n'est pas fait de boîtes (modèle retouché), on prend sa boîte englobante par triangle.
function meshBoxes(mesh) {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry, p = g.attributes.position, idx = g.index;
  const n = idx ? idx.count : p.count, get = (i) => (idx ? idx.getX(i) : i);
  const v = new THREE.Vector3(), out = [];
  const isBox = n % 36 === 0;
  const per = isBox ? 36 : 3;
  for (let k = 0; k < n; k += per) {
    const b = new THREE.Box3();
    const corners = new Set();
    for (let j = k; j < k + per; j++) {
      v.fromBufferAttribute(p, get(j)).applyMatrix4(mesh.matrixWorld); b.expandByPoint(v);
      corners.add(v.toArray().map((c) => c.toFixed(3)).join(','));
    }
    if (isBox && corners.size !== 8) return meshBoxesTri(mesh);
    out.push(b);
  }
  return out;
}
function meshBoxesTri(mesh) {
  const g = mesh.geometry, p = g.attributes.position, idx = g.index, n = idx ? idx.count : p.count;
  const v = new THREE.Vector3(), out = [];
  for (let k = 0; k < n; k += 3) {
    const b = new THREE.Box3();
    for (let j = k; j < k + 3; j++) { v.fromBufferAttribute(p, idx ? idx.getX(j) : j).applyMatrix4(mesh.matrixWorld); b.expandByPoint(v); }
    b.expandByScalar(0.01); out.push(b);
  }
  return out;
}
const hps = []; // { name, el, node, spec }

let composer = null, ao = null;
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(innerWidth, innerHeight); }
}
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- chargement
try {
  // version.txt est réécrit à chaque publication depuis Blender : il force le rechargement du GLB
  // (sinon navigateur et GitHub Pages peuvent servir l'ancien fichier pendant ~10 min)
  let v = '';
  try { v = (await fetch('version.txt', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''))).trim(); } catch {}
  await stage.load('salle_des_fetes.glb' + (v ? '?v=' + encodeURIComponent(v) : ''));
} catch (e) {
  $('load').textContent = 'Erreur de chargement : ' + e.message; throw e;
}
initial = stage.applyInitialView(camera, controls);
camera.far = 400; camera.near = 0.3; camera.updateProjectionMatrix();

// ---------------------------------------------------------------- ombres de contact
// L'ombre de contact de product-loader est un plan unique posé sous le point le plus bas
// de la scène : pour un bâtiment, il se retrouve sous la dalle, invisible. On la remplace
// par une occlusion ambiante (GTAO) : ombre douce sous chaque meuble et dans les angles.
// Réglages repris de Blender (panneau « Rendu de la visionneuse ») :
//   Ombre de contact -> activée / désactivée (désactivée d'office si le GLB contient des ombres cuites)
//   Opacité des ombres au sol -> force de l'ombre (0 = aucune, 0,5 = normale, 1 = forte)
//   Flou -> rayon de l'ombre (0 -> 40 cm, 2,5 -> 80 cm, 10 -> 2 m)
const ground = stage.settings.ground;

// Occlusion cuite dans Blender (add-on Publication GitHub) : occlusionTexture glTF sur TEXCOORD_1.
// three.js ne l'applique qu'à la lumière indirecte ; ici les plafonniers (lumière directe)
// éclairent l'essentiel, donc on l'applique aussi au direct pour que les ombres se voient.
let bakedAO = 0;
stage.scene.traverse((o) => {
  if (!o.isMesh) return;
  for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m.aoMap || m.userData.__aoDirect) continue;
    m.userData.__aoDirect = true;
    m.aoMapIntensity = Math.min(1.5, ground.opacity * 2);
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
#ifdef USE_AOMAP
  reflectedLight.directDiffuse *= ambientOcclusion;
  reflectedLight.directSpecular *= ambientOcclusion;
#endif`);
    };
    m.customProgramCacheKey = () => 'aoDirect';
    m.needsUpdate = true;
    bakedAO++;
  }
});
stage.contact.setOptions({ opacity: ground.opacity, blur: ground.blur, enabled: false });
composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(stage.scene, camera));
ao = new GTAOPass(stage.scene, camera, innerWidth, innerHeight);
ao.blendIntensity = Math.min(1, ground.opacity * 2);
ao.updateGtaoMaterial({ radius: 0.4 + ground.blur * 0.16, distanceExponent: 1.5, thickness: 10, scale: 0.5 + ground.opacity * 3, samples: 16 });
ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
ao.enabled = !!ground.contactShadow && bakedAO === 0;  // ombres cuites présentes : l'AO écran devient optionnelle
composer.addPass(ao);
composer.addPass(new OutputPass());
resize();
$('tShadow').classList.toggle('on', ao.enabled);
$('tShadow').onclick = () => { ao.enabled = !ao.enabled; $('tShadow').classList.toggle('on', ao.enabled); };

for (const m of stage.meshes) {
  const n = m.userData.name ?? m.parent?.userData?.name ?? m.name;
  if (/^(Plafond|Luminaires|Toiture)/.test(n)) { hide.orbit.push(m); continue; }
  if (/^(Sol_|Escaliers)/.test(n)) { floors.push(m); floorBoxes.push(...meshBoxes(m)); continue; }
  if (/^(Chaises|Tables|Bar|Cuisine|Sanitaires|Vestiaire|Rayonnages|Pupitre|Cabines)/.test(n)) furniture.push(m);
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
$('tFurn').onclick = () => {
  const on = !$('tFurn').classList.contains('on'); $('tFurn').classList.toggle('on', on);
  furniture.forEach((m) => { m.visible = on; });
  stage.contactDirty = true;
};

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
  fly(target.clone().addScaledVector(dir, isBig(h) ? 24 : 11), target);
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

// dessus du sol le plus haut sous (x,z) : plancher, marche ou scène (null hors du bâtiment)
function floorAt(x, z) {
  let best = null;
  for (const b of floorBoxes) {
    if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
    if (best === null || b.max.y > best) best = b.max.y;
  }
  return best;
}
// vrai si le visiteur (cylindre RADIUS, de fy+0.1 à fy+1.85) ne touche aucun solide visible
function clearAt(x, z, fy) {
  const y0 = fy + 0.1, y1 = fy + 1.85, r2 = RADIUS * RADIUS;
  for (const b of solidBoxes) {
    if (!b.mesh.visible) continue;
    if (b.max.y < y0 || b.min.y > y1) continue;
    const cx = Math.max(b.min.x, Math.min(x, b.max.x)), cz = Math.max(b.min.z, Math.min(z, b.max.z));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < r2) return false;
  }
  return true;
}
// déplacement élémentaire (≤ SUBSTEP < 2×RADIUS : aucune paroi ne peut être sautée), glissement le long des murs
function tryMove(dx, dz) {
  for (const [mx, mz] of [[dx, dz], [dx, 0], [0, dz]]) {
    if (!mx && !mz) continue;
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

// ---------------------------------------------------------------- mini-carte
const mapc = $('mapc'), mx = mapc.getContext('2d');
const planImg = new Image(); planImg.src = 'plan.jpg';
const toMap = (x, z) => [OX + x * 100 * S, OY + z * 100 * S];
function drawMap() {
  mx.clearRect(0, 0, 740, 540);
  if (planImg.complete) mx.drawImage(planImg, 0, 0);
  const p = mode === 'walk' ? camera.position : controls.target;
  const [px, py] = toMap(p.x, p.z);
  const f = new THREE.Vector3(); camera.getWorldDirection(f); const a = Math.atan2(f.z, f.x);
  mx.fillStyle = 'rgba(158,27,34,.25)'; mx.beginPath(); mx.moveTo(px, py); mx.arc(px, py, 64, a - 0.6, a + 0.6); mx.closePath(); mx.fill();
  mx.fillStyle = '#9e1b22'; mx.beginPath(); mx.arc(px, py, 9, 0, 7); mx.fill(); mx.strokeStyle = '#fff'; mx.lineWidth = 3; mx.stroke();
}
$('map').addEventListener('click', (e) => {
  const r = mapc.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width * 740, cy = (e.clientY - r.top) / r.height * 540;
  const x = (cx - OX) / S / 100, z = (cy - OY) / S / 100;
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
  drawMap();
  if (ao.enabled) composer.render(dt); else renderer.render(stage.scene, camera);
});
setMode('orbit');
$('load').remove();
window.__viewer = { get bakedAO() { return bakedAO; }, stage, solidBoxes, floorBoxes, get composer() { return composer; }, get ao() { return ao; }, camera, pos, move, placeAt, findFree, get feet() { return feet; }, setMode };
