// product-loader.js — module de référence de la visionneuse.
//
// Charge un GLB exporté selon le contrat « viewer-scene/1 » et construit la scène
// three.js exactement comme l'aperçu Blender. Aucune dépendance au site, à l'UI
// ou à Blender : le partenaire l'importe tel quel et garde la main sur l'interface
// (boutons, fiches, intégration).
//
//   import { createRenderer, ProductStage } from './core/product-loader.js';
//   const renderer = createRenderer(canvas);
//   const stage = new ProductStage(renderer, { environmentUrl: f => `/env/${f}` });
//   const product = await stage.load('/produits/REF-1234.glb');
//   stage.applyInitialView(camera, controls);
//   renderer.setAnimationLoop(t => { stage.update(t); renderer.render(stage.scene, camera); });
//
// three.js r186. Contrat détaillé : document « Visionneuse 3D — Contrat GLB ».

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

export const SCHEMA = 'viewer-scene/1';

// Réglages appliqués à un GLB qui n'a pas d'extras « viewer » (fichier tiers).
export const DEFAULT_SETTINGS = Object.freeze({
  toneMapping: 'AgX',
  exposure: 1,
  environment: { source: 'STUDIO', file: null, color: [0.05, 0.05, 0.05], intensity: 1, rotation: 0 },
  background: { mode: 'ENVIRONMENT', color: [0.94, 0.94, 0.94], blur: 0 },
  shadows: { enabled: true },
  ground: { contactShadow: true, opacity: 0.5, blur: 2.5 },
});

const TONE_MAPPING = {
  None: THREE.NoToneMapping, Linear: THREE.LinearToneMapping, Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping, ACESFilmic: THREE.ACESFilmicToneMapping,
  AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping,
};

// ---------------------------------------------------------------------------
// Renderer : les réglages qui conditionnent la fidélité
// ---------------------------------------------------------------------------
let areaLibReady = false;

export function createRenderer(canvas, { antialias = true, pixelRatioMax = 2, shadowType = THREE.PCFShadowMap } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioMax));
  renderer.outputColorSpace = THREE.SRGBColorSpace;   // défaut three.js, à ne pas changer
  renderer.toneMapping = THREE.AgXToneMapping;          // remplacé par les extras du GLB
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = shadowType;
  if (!areaLibReady) { RectAreaLightUniformsLib.init(); areaLibReady = true; }
  return renderer;
}

function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
      ? { ...out[k], ...v } : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ombre de contact (ombre douce au sol, indépendante des lumières)
// D'après l'exemple officiel three.js « webgl_shadow_contact ».
// ---------------------------------------------------------------------------
class ContactShadow {
  constructor(renderer) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = '__contactShadow';
    this.rt = new THREE.WebGLRenderTarget(512, 512);
    this.rtBlur = new THREE.WebGLRenderTarget(512, 512);
    this.rt.texture.generateMipmaps = this.rtBlur.texture.generateMipmaps = false;
    this.depthMaterial = new THREE.MeshDepthMaterial();
    this.depthMaterial.userData.darkness = { value: 1 };
    this.depthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depthMaterial.userData.darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );')}`;
    };
    this.depthMaterial.depthTest = this.depthMaterial.depthWrite = false;
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.hBlur.depthTest = this.vBlur.depthTest = false;
    this.opacity = 0.5;
    this.blur = 2.5;
    this.plane = null;
  }

  fit(box) {
    this.disposeMeshes();
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const w = Math.max(size.x, 0.01) * 1.6, d = Math.max(size.z, 0.01) * 1.6, h = Math.max(size.y, 0.01);
    const geo = new THREE.PlaneGeometry(w, d).rotateX(Math.PI / 2);
    this.plane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this.rt.texture, opacity: this.opacity, transparent: true, depthWrite: false,
    }));
    this.plane.renderOrder = 1;
    this.plane.scale.y = -1;
    this.blurPlane = new THREE.Mesh(geo);
    this.blurPlane.visible = false;
    this.camera = new THREE.OrthographicCamera(-w / 2, w / 2, d / 2, -d / 2, 0, h);
    this.camera.rotation.x = Math.PI / 2;
    this.group.add(this.plane, this.blurPlane, this.camera);
    this.group.position.set(center.x, box.min.y + Math.max(size.y, 0.01) * 0.001, center.z);
  }

  blurPass(amount) {
    const r = this.renderer;
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    r.setRenderTarget(this.rtBlur);
    r.render(this.blurPlane, this.camera);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    r.setRenderTarget(this.rt);
    r.render(this.blurPlane, this.camera);
    this.blurPlane.visible = false;
  }

  render(scene, hide) {
    if (!this.plane || !this.group.visible) return;
    const r = this.renderer;
    const prev = { bg: scene.background, om: scene.overrideMaterial, target: r.getRenderTarget(), alpha: r.getClearAlpha() };
    const hidden = hide.filter((o) => o.visible);
    hidden.forEach((o) => { o.visible = false; });
    this.group.visible = false;
    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    r.setClearAlpha(0);
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, this.camera);
    scene.overrideMaterial = prev.om;
    this.blurPass(this.blur);
    this.blurPass(this.blur * 0.4);
    r.setRenderTarget(prev.target);
    r.setClearAlpha(prev.alpha);
    scene.background = prev.bg;
    this.group.visible = true;
    hidden.forEach((o) => { o.visible = true; });
  }

  setOptions({ opacity, blur, enabled }) {
    this.opacity = opacity;
    this.blur = blur;
    if (this.plane) this.plane.material.opacity = opacity;
    this.group.visible = !!enabled;
  }

  disposeMeshes() {
    if (!this.plane) return;
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.group.clear();
    this.plane = null;
  }

  dispose() {
    this.disposeMeshes();
    this.rt.dispose(); this.rtBlur.dispose();
    this.depthMaterial.dispose(); this.hBlur.dispose(); this.vBlur.dispose();
  }
}

// ---------------------------------------------------------------------------
// Scène produit
// ---------------------------------------------------------------------------
export class ProductStage {
  /**
   * @param {THREE.WebGLRenderer} renderer  créé par createRenderer()
   * @param {object} options
   * @param {(file:string)=>string} [options.environmentUrl]  URL d'une HDRI de la bibliothèque à partir de son nom
   * @param {string} [options.dracoPath]  dossier des décodeurs Draco
   * @param {(msg:string)=>void} [options.onWarning]
   */
  constructor(renderer, { environmentUrl, dracoPath = new URL('../vendor/addons/libs/draco/gltf/', import.meta.url).href, onWarning } = {}) {
    this.renderer = renderer;
    this.environmentUrl = environmentUrl ?? ((f) => `environments/${encodeURIComponent(f)}`);
    this.warn = onWarning ?? ((m) => console.warn('[viewer]', m));
    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.root.name = '__product';
    this.scene.add(this.root);

    const draco = new DRACOLoader().setDecoderPath(dracoPath);
    this.loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envCache = new Map();
    this.contact = new ContactShadow(renderer);
    this.scene.add(this.contact.group);
    this.raycaster = new THREE.Raycaster();
    this.reset();
  }

  reset() {
    this.gltf = null;
    this.nodes = new Map();      // nom d'objet Blender -> Object3D
    this.lights = new Map();     // nom -> { node, light, spec }
    this.hotspots = new Map();   // nom -> { node, spec, virtual }
    this.materials = new Map();  // nom de matériau -> [Material]
    this.meshes = [];
    this.catchers = [];
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.lightUnits = null;
    this.mixer = null;
    this.clips = [];
    this.clipState = new Map();
    this.actions = new Set();
    this.cameraNode = null;
    this.bounds = { box: new THREE.Box3(), center: new THREE.Vector3(), radius: 1 };
    this.contactDirty = true;
  }

  // ---- chargement --------------------------------------------------------
  /** @param {string|ArrayBuffer} source URL du GLB ou contenu binaire */
  async load(source) {
    const gltf = typeof source === 'string'
      ? await this.loader.loadAsync(source)
      : await this.loader.parseAsync(source, '');
    this.clear();
    this.gltf = gltf;
    this.root.add(gltf.scene);

    const viewer = gltf.scene.userData?.viewer ?? gltf.scenes?.[0]?.userData?.viewer ?? null;
    if (viewer && viewer.schema !== SCHEMA) this.warn(`Schéma inattendu : ${viewer.schema}`);
    this.lightUnits = viewer?.exportedLightUnits ?? null;

    const lightNodes = [];
    gltf.scene.traverse((o) => {
      const name = o.userData?.name;
      if (name && !this.nodes.has(name)) this.nodes.set(name, o);
      const ud = o.userData ?? {};
      if (ud.light) lightNodes.push(o);
      if (ud.hotspot) this.hotspots.set(name, { node: o, spec: ud.hotspot, virtual: false });
      if (ud.viewerCamera && !this.cameraNode) this.cameraNode = o;
      if (ud.hidden) o.visible = false;
      if (o.isMesh) this.registerMesh(o);
    });
    // lumières : la spécification des extras fait foi (Area comprises).
    // GLTFLoader fait de la lumière KHR le nœud lui-même quand le nœud ne porte
    // qu'elle : on la remplace par un nœud porteur de même nom et même transformation.
    for (let node of lightNodes) {
      if (node.isLight) node = this.replaceWithHolder(node);
      this.setLight(node.userData.name, node.userData.light);
    }
    // GLB tiers ou lumières sans extras : unités KHR ramenées à celles de three.js
    gltf.scene.traverse((o) => {
      if (o.isLight && !o.userData.__fromSpec) this.normalizeKhrLight(o);
    });

    this.mixer = new THREE.AnimationMixer(gltf.scene);
    this.clips = gltf.animations ?? [];
    this.computeBounds();
    this.contact.fit(this.bounds.box);
    await this.applySettings(viewer ?? {});
    return this;
  }

  replaceWithHolder(obj) {
    const holder = new THREE.Object3D();
    holder.name = obj.name;
    holder.userData = obj.userData;
    holder.position.copy(obj.position);
    holder.quaternion.copy(obj.quaternion);
    holder.scale.copy(obj.scale);
    holder.visible = obj.visible;
    for (const c of [...obj.children]) if (c !== obj.target) holder.add(c);
    const parent = obj.parent;
    parent.children.splice(parent.children.indexOf(obj), 1, holder);
    holder.parent = parent;
    obj.parent = null;
    obj.dispose?.();
    if (holder.userData.name) this.nodes.set(holder.userData.name, holder);
    return holder;
  }

  registerMesh(o) {
    let catcher = false, cast = true;
    for (let p = o; p && p !== this.root; p = p.parent) {
      if (p.userData?.shadowCatcher) catcher = true;
      if (p.userData?.castShadow === false) cast = false;
    }
    if (catcher) {
      o.material = new THREE.ShadowMaterial({ opacity: this.settings.ground.opacity });
      o.castShadow = false;
      o.receiveShadow = true;
      o.userData.__catcher = true;
      this.catchers.push(o);
      return;
    }
    o.castShadow = cast;
    o.receiveShadow = true;
    this.meshes.push(o);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!this.materials.has(m.name)) this.materials.set(m.name, []);
      this.materials.get(m.name).push(m);
    }
  }

  normalizeKhrLight(light) {
    const units = this.lightUnits;
    if (!units || units === 'COMPAT') return;
    const punctual = light.isPointLight || light.isSpotLight;
    if (units === 'SPEC') light.intensity /= 683;
    if (units === 'RAW' && punctual) light.intensity /= 4 * Math.PI;
  }

  computeBounds() {
    const box = new THREE.Box3();
    this.root.updateWorldMatrix(true, true);
    for (const m of this.meshes) if (m.visible) box.expandByObject(m);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.bounds = { box, center: sphere.center, radius: Math.max(sphere.radius, 0.01) };
    for (const e of this.lights.values()) this.fitLightShadow(e);
  }

  // ---- réglages globaux --------------------------------------------------
  async applySettings(spec) {
    const s = this.settings = merge(DEFAULT_SETTINGS, spec);
    const r = this.renderer;
    if (!(s.toneMapping in TONE_MAPPING)) this.warn(`Tone mapping inconnu : ${s.toneMapping}`);
    r.toneMapping = TONE_MAPPING[s.toneMapping] ?? THREE.AgXToneMapping;
    r.toneMappingExposure = s.exposure;

    const env = s.environment;
    let tex = null, bgTex = null;
    if (env.source === 'HDRI' && env.file) {
      try {
        bgTex = await this.loadEquirect(env.file);
        tex = bgTex;
      } catch (err) {
        this.warn(`HDRI « ${env.file} » introuvable (${err.message}) : studio intégré utilisé`);
      }
    } else if (env.source === 'COLOR') {
      tex = this.colorEnvironment(env.color);
    }
    if (!tex) tex = this.studioEnvironment();
    const scene = this.scene;
    scene.environment = tex;
    scene.environmentIntensity = env.intensity;
    // Rotation du nœud Mapping de Blender (axe Z) -> rotation autour de Y.
    // Vérifié par rendu comparé Cycles / three.js (bandes de couleur, 4 directions, 2 rotations).
    const rotY = -(env.rotation ?? 0);
    scene.environmentRotation.set(0, rotY, 0);
    scene.backgroundRotation.set(0, rotY, 0);

    const bg = s.background;
    scene.backgroundBlurriness = 0;
    scene.backgroundIntensity = 1;
    if (bg.mode === 'TRANSPARENT') {
      scene.background = null;
      r.setClearColor(0x000000, 0);
    } else if (bg.mode === 'COLOR') {
      scene.background = new THREE.Color().setRGB(...bg.color);
    } else if (env.source === 'COLOR') {
      scene.background = new THREE.Color().setRGB(...env.color.map((c) => c * env.intensity));
    } else {
      scene.background = bgTex ?? tex;
      scene.backgroundIntensity = env.intensity;
      scene.backgroundBlurriness = bg.blur ?? 0;
    }

    for (const e of this.lights.values()) this.updateLightShadow(e);
    for (const c of this.catchers) c.material.opacity = s.ground.opacity;
    this.contact.setOptions({ opacity: s.ground.opacity, blur: s.ground.blur, enabled: s.ground.contactShadow });
    this.contactDirty = true;
  }

  async loadEquirect(file) {
    const url = this.environmentUrl(file);
    if (this.envCache.has(url)) return this.envCache.get(url);
    const ext = file.toLowerCase().split('.').pop();
    let tex;
    if (ext === 'hdr') tex = await new HDRLoader().loadAsync(url);
    else if (ext === 'exr') tex = await new EXRLoader().loadAsync(url);
    else { tex = await new THREE.TextureLoader().loadAsync(url); tex.colorSpace = THREE.SRGBColorSpace; }
    tex.mapping = THREE.EquirectangularReflectionMapping;
    this.envCache.set(url, tex);
    return tex;
  }

  studioEnvironment() {
    if (!this.envCache.has('__studio')) {
      const room = new RoomEnvironment();
      this.envCache.set('__studio', this.pmrem.fromScene(room, 0.04).texture);
      room.dispose?.();
    }
    return this.envCache.get('__studio');
  }

  colorEnvironment(color) {
    const key = `__color:${color.join(',')}`;
    if (!this.envCache.has(key)) {
      const tmp = new THREE.Scene();
      tmp.background = new THREE.Color().setRGB(...color);
      this.envCache.set(key, this.pmrem.fromScene(tmp, 0).texture);
    }
    return this.envCache.get(key);
  }

  // ---- lumières ----------------------------------------------------------
  /** Crée ou met à jour la lumière portée par le nœud `name` (spécification extras.light). */
  setLight(name, spec) {
    let e = this.lights.get(name);
    if (!e) {
      const node = this.nodes.get(name) ?? this.virtualNode(name, null);
      // retire la lumière KHR créée par GLTFLoader : la spécification la remplace
      for (const c of [...node.children]) if (c.isLight) { c.removeFromParent(); c.dispose?.(); }
      e = { node, light: null, spec: null };
      this.lights.set(name, e);
    }
    if (!e.light || e.light.userData.kind !== spec.type) {
      if (e.light) { e.light.removeFromParent(); e.light.dispose?.(); }
      e.light = this.makeLight(spec.type);
      e.node.add(e.light);
    }
    e.spec = spec;
    const L = e.light;
    L.color.setRGB(spec.color[0], spec.color[1], spec.color[2]); // linéaire, comme Blender et GLTFLoader
    if (spec.type === 'AREA') {
      L.width = spec.width; L.height = spec.height;
      L.power = spec.power;
    } else {
      L.intensity = spec.intensity;
    }
    if (spec.type === 'SPOT') { L.angle = spec.angle; L.penumbra = spec.penumbra; }
    this.fitLightShadow(e);
    this.updateLightShadow(e);
    return e;
  }

  makeLight(type) {
    let L;
    if (type === 'SUN') L = new THREE.DirectionalLight();
    else if (type === 'SPOT') L = new THREE.SpotLight();
    else if (type === 'AREA') L = new THREE.RectAreaLight();
    else L = new THREE.PointLight();
    if (L.isPointLight || L.isSpotLight) { L.decay = 2; L.distance = 0; }
    if (L.target) { L.target.position.set(0, 0, -1); L.add(L.target); }   // émission selon -Z local
    if (L.shadow) {
      L.shadow.mapSize.set(2048, 2048);
      L.shadow.bias = -0.0002;
      L.shadow.radius = 6;          // bord d'ombre adouci (PCF)
      L.shadow.blurSamples = 16;
    }
    L.userData.kind = type;
    L.userData.__fromSpec = true;
    return L;
  }

  updateLightShadow(e) {
    const L = e.light;
    if (!L?.shadow) return;
    L.castShadow = !!(this.settings.shadows.enabled && e.spec?.shadow);
  }

  fitLightShadow(e) {
    const L = e.light;
    if (!L?.shadow) return;
    const { center, radius } = this.bounds;
    L.shadow.normalBias = radius * 0.004;
    if (L.isDirectionalLight) {
      // la position du soleil n'a pas de sens physique : on garde sa direction
      // et on place la caméra d'ombre autour du produit
      e.node.updateWorldMatrix(true, false);
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(e.node.matrixWorld);
      const from = center.clone().addScaledVector(dir, -radius * 3);
      L.position.copy(e.node.worldToLocal(from.clone()));
      L.target.position.copy(e.node.worldToLocal(center.clone()));
      const c = L.shadow.camera, r = radius * 1.1;
      c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.near = radius * 0.5; c.far = radius * 6;
      c.updateProjectionMatrix();
    } else {
      L.shadow.camera.near = Math.max(radius * 0.01, 0.005);
      L.shadow.camera.far = radius * 50;
      L.shadow.camera.updateProjectionMatrix();
    }
  }

  // ---- transformations, points d'intérêt, matériaux (synchro directe) -----
  virtualNode(name, parentName) {
    const o = new THREE.Object3D();
    o.name = name;
    o.userData.name = name;
    o.userData.__virtual = true;
    (parentName && this.nodes.get(parentName) || this.root).add(o);
    this.nodes.set(name, o);
    return o;
  }

  /** t = { parent, local:number[16], world:number[16], visible } — repère glTF, colonne-major */
  applyNodeTransform(name, t) {
    const node = this.nodes.get(name) ?? this.virtualNode(name, t.parent);
    const m = new THREE.Matrix4();
    if (t.parent && node.parent?.userData?.name === t.parent) {
      m.fromArray(t.local);
    } else {
      node.parent.updateWorldMatrix(true, false);
      m.copy(node.parent.matrixWorld).invert().multiply(new THREE.Matrix4().fromArray(t.world));
    }
    m.decompose(node.position, node.quaternion, node.scale);
    node.visible = t.visible !== false;
    node.updateWorldMatrix(false, true);
    const e = this.lights.get(name);
    if (e) this.fitLightShadow(e);
    this.contactDirty = true;
    return node;
  }

  setHotspot(name, spec) {
    const node = this.nodes.get(name) ?? this.virtualNode(name, null);
    const h = this.hotspots.get(name);
    if (h) { h.spec = spec; h.node = node; } else this.hotspots.set(name, { node, spec, virtual: !!node.userData.__virtual });
  }

  removeNode(name) {
    const e = this.lights.get(name);
    if (e) { e.light.removeFromParent(); e.light.dispose?.(); this.lights.delete(name); }
    this.hotspots.delete(name);
    const node = this.nodes.get(name);
    if (node?.userData.__virtual) { node.removeFromParent(); this.nodes.delete(name); }
    else if (node) node.visible = false;
    this.contactDirty = true;
  }

  removeLight(name) {
    const e = this.lights.get(name);
    if (!e) return;
    e.light.removeFromParent(); e.light.dispose?.();
    this.lights.delete(name);
  }

  applyMaterial(name, d) {
    for (const m of this.materials.get(name) ?? []) {
      if (d.color && m.color) m.color.setRGB(d.color[0], d.color[1], d.color[2]);
      if (d.metalness !== undefined && 'metalness' in m) m.metalness = d.metalness;
      if (d.roughness !== undefined && 'roughness' in m) m.roughness = d.roughness;
      if (d.emissive && m.emissive) m.emissive.setRGB(d.emissive[0], d.emissive[1], d.emissive[2]);
      if (d.emissiveIntensity !== undefined && 'emissiveIntensity' in m) m.emissiveIntensity = d.emissiveIntensity;
      if (d.opacity !== undefined && m.transparent) m.opacity = d.opacity;
    }
  }

  // ---- points d'intérêt : aides pour l'interface ---------------------------
  hotspotWorldPosition(name, target = new THREE.Vector3()) {
    const h = this.hotspots.get(name);
    return h ? h.node.getWorldPosition(target) : null;
  }

  /** Vrai si un maillage du produit cache le point vu depuis la caméra. */
  isHotspotOccluded(name, camera) {
    const p = this.hotspotWorldPosition(name);
    if (!p) return false;
    const dist = camera.position.distanceTo(p);
    this.raycaster.set(camera.position, p.clone().sub(camera.position).normalize());
    this.raycaster.far = dist;
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    return !!hit && hit.distance < dist - this.bounds.radius * 0.01;
  }

  // ---- animations --------------------------------------------------------
  findClip(name) {
    const n = String(name).toLowerCase();
    return this.clips.find((c) => c.name === name)
      ?? this.clips.find((c) => c.name.toLowerCase() === n)
      ?? this.clips.find((c) => c.name.toLowerCase().includes(n));
  }

  /** mode : 'toggle' (ouvre / referme), 'once', 'loop'. Renvoie { ok, open, message }. */
  playClip(name, mode = 'toggle') {
    if (!this.mixer) return { ok: false, message: 'Aucun produit chargé' };
    const clip = this.findClip(name);
    if (!clip) {
      const list = this.clips.map((c) => c.name).join(', ') || 'aucune';
      return { ok: false, message: `Animation « ${name} » introuvable. Disponibles : ${list}` };
    }
    const a = this.mixer.clipAction(clip);
    a.enabled = true;
    this.actions.add(a);
    if (mode === 'loop') {
      a.setLoop(THREE.LoopRepeat, Infinity);
      if (a.isRunning()) { a.stop(); return { ok: true, open: false }; }
      a.reset().play();
      return { ok: true, open: true };
    }
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    if (mode === 'once') { a.timeScale = 1; a.reset().play(); return { ok: true, open: true }; }
    const open = !this.clipState.get(clip.name);
    this.clipState.set(clip.name, open);
    a.paused = false;
    a.timeScale = open ? 1 : -1;
    if (!a.isRunning()) {
      if (open && a.time >= clip.duration) a.time = 0;
      if (!open && a.time <= 0) a.time = clip.duration;
    }
    a.play();
    return { ok: true, open };
  }

  // ---- caméra ------------------------------------------------------------
  /** Point de vue initial : caméra active de Blender si exportée, sinon cadrage automatique. */
  initialView() {
    const { center, radius } = this.bounds;
    const n = this.cameraNode;
    const cam = n ? (n.isCamera ? n : n.children.find((c) => c.isCamera) ?? null) : null;
    if (cam) {
      const position = cam.getWorldPosition(new THREE.Vector3());
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
      const t = Math.max(center.clone().sub(position).dot(dir), radius * 0.5);
      return { position, target: position.clone().addScaledVector(dir, t), fov: cam.fov, fromBlender: true };
    }
    const fov = 40;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(fov) / 2) * 1.15;
    const position = center.clone().add(new THREE.Vector3(1, 0.6, 1.2).normalize().multiplyScalar(dist));
    return { position, target: center.clone(), fov, fromBlender: false };
  }

  applyInitialView(camera, controls) {
    const v = this.initialView();
    camera.position.copy(v.position);
    camera.fov = v.fov;
    camera.near = this.bounds.radius / 100;
    camera.far = this.bounds.radius * 100 + v.position.distanceTo(this.bounds.center);
    camera.updateProjectionMatrix();
    camera.lookAt(v.target);
    if (controls) { controls.target.copy(v.target); controls.update(); }
    return v;
  }

  // ---- boucle ------------------------------------------------------------
  update(dt) {
    let animating = false;
    if (this.mixer) {
      this.mixer.update(dt);
      for (const a of this.actions) if (a.isRunning()) { animating = true; break; }
    }
    if (animating || this.contactDirty) {
      this.contact.render(this.scene, this.catchers);
      this.contactDirty = false;
    }
  }

  // ---- nettoyage ---------------------------------------------------------
  clear() {
    this.mixer?.stopAllAction();
    for (const c of [...this.root.children]) {
      c.traverse((o) => {
        o.geometry?.dispose();
        for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
          for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
          m.dispose();
        }
        o.dispose?.();
      });
      c.removeFromParent();
    }
    this.reset();
  }

  dispose() {
    this.clear();
    this.contact.dispose();
    for (const t of this.envCache.values()) t.dispose?.();
    this.envCache.clear();
    this.pmrem.dispose();
  }
}
