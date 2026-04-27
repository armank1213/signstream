import * as THREE from '../lib/three.module.min.js';
import { GLTFLoader } from '../lib/GLTFLoader.mjs';

// Runs in the PAGE world (injected by the content script)
// Listens for window.postMessage events from SignStream content script.

const STATE = {
  ready: false,
  modelUrl: null,
  scene: null,
  camera: null,
  renderer: null,
  clock: null,
  avatar: null,
  bones: {},
  gesture: { name: null, t0: 0 },
};

function logStatus(text) {
  try {
    window.postMessage({ __signstream: true, type: 'AVATAR_STATUS', status: text }, '*');
  } catch {}
}

function ensureMount() {
  const wrap = document.getElementById('signstream-avatar-wrap');
  if (!wrap) return null;

  let canvas = document.getElementById('signstream-avatar-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'signstream-avatar-canvas';
    canvas.style.width = '220px';
    canvas.style.height = '220px';
    canvas.style.borderRadius = '16px';
    canvas.style.border = '1px solid rgba(255,255,255,0.20)';
    canvas.style.background = 'rgba(255,255,255,0.06)';
    canvas.style.display = 'block';
    wrap.appendChild(canvas);
  }

  let label = document.getElementById('signstream-avatar-label');
  if (!label) {
    label = document.createElement('div');
    label.id = 'signstream-avatar-label';
    label.style.marginTop = '8px';
    label.style.fontSize = '13px';
    label.style.fontWeight = '700';
    label.style.opacity = '0.9';
    wrap.appendChild(label);
  }

  return { wrap, canvas, label };
}

function findFirstByName(root, patterns) {
  if (!root) return null;
  const pats = (patterns || []).map((p) => String(p).toLowerCase());
  let best = null;
  root.traverse((o) => {
    if (!o || !o.name) return;
    const n = String(o.name).toLowerCase();
    if (pats.some((p) => n.includes(p))) best = o;
  });
  return best;
}

function cacheBones(avatarRoot) {
  // VRoid-ish naming; fall back to generic "hand" searches.
  const rightHand = findFirstByName(avatarRoot, [
    'r_hand',
    'righthand',
    'j_bip_r_hand',
    'hand_r',
    'rhand',
    'handright',
    'hand',
  ]);
  const leftHand = findFirstByName(avatarRoot, [
    'l_hand',
    'lefthand',
    'j_bip_l_hand',
    'hand_l',
    'lhand',
    'handleft',
    'hand',
  ]);
  const head = findFirstByName(avatarRoot, ['head']);

  STATE.bones = { rightHand, leftHand, head };
}

function setupThree(canvas) {
  STATE.clock = new THREE.Clock();
  STATE.scene = new THREE.Scene();

  const w = canvas.clientWidth || 220;
  const h = canvas.clientHeight || 220;
  STATE.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100);
  STATE.camera.position.set(0, 1.35, 2.2);

  STATE.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  STATE.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  STATE.renderer.setSize(w, h, false);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  hemi.position.set(0, 2, 0);
  STATE.scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 2, 1);
  STATE.scene.add(dir);
}

async function loadModel(url) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  return gltf;
}

function resetRotation(o, s = 0.15) {
  if (!o || !o.rotation) return;
  o.rotation.x *= 1 - s;
  o.rotation.y *= 1 - s;
  o.rotation.z *= 1 - s;
}

function applyGesture(name, t) {
  const { rightHand, leftHand, head } = STATE.bones || {};

  resetRotation(rightHand);
  resetRotation(leftHand);
  resetRotation(head, 0.08);

  const wave = Math.sin(t * Math.PI * 2);

  if (name === 'HELLO') {
    if (rightHand) rightHand.rotation.z += wave * 0.6;
  } else if (name === 'YES') {
    if (head) head.rotation.x += Math.sin(t * Math.PI * 4) * 0.15;
  } else if (name === 'NO') {
    if (head) head.rotation.y += Math.sin(t * Math.PI * 4) * 0.25;
  } else if (name === 'THANK') {
    if (rightHand) rightHand.rotation.x += -0.6 * Math.sin(t * Math.PI);
  } else if (name === 'PLEASE') {
    if (rightHand) rightHand.rotation.y += 0.4 * Math.sin(t * Math.PI * 2);
  } else if (name === 'HELP') {
    if (leftHand) leftHand.rotation.y += -0.35 * Math.sin(t * Math.PI);
    if (rightHand) rightHand.rotation.y += 0.35 * Math.sin(t * Math.PI);
  } else {
    if (rightHand) rightHand.rotation.x += 0.25 * Math.sin(t * Math.PI * 2);
  }
}

function animate() {
  if (!STATE.renderer || !STATE.scene || !STATE.camera) return;

  // idle motion
  if (STATE.avatar) {
    STATE.avatar.rotation.y = Math.sin(Date.now() / 2000) * 0.15;
  }

  if (STATE.gesture?.name) {
    const dur = 0.85;
    const t = Math.min(1, (performance.now() - STATE.gesture.t0) / (dur * 1000));
    applyGesture(STATE.gesture.name, t);
    if (t >= 1) STATE.gesture.name = null;
  }

  const canvas = STATE.renderer.domElement;
  const w = canvas.clientWidth || 220;
  const h = canvas.clientHeight || 220;

  STATE.renderer.setSize(w, h, false);
  STATE.camera.aspect = w / h;
  STATE.camera.updateProjectionMatrix();

  STATE.renderer.render(STATE.scene, STATE.camera);
  requestAnimationFrame(animate);
}

async function init(modelUrl) {
  const mount = ensureMount();
  if (!mount) return;

  const { canvas, label } = mount;

  setupThree(canvas);

  label.textContent = 'Loading avatar…';

  if (!modelUrl) {
    label.textContent = 'Missing avatar model (assets/avatar/model.vrm)';
    logStatus('Missing avatar model');
    return;
  }

  try {
    const gltf = await loadModel(modelUrl);
    const root = gltf.scene;
    STATE.avatar = root;
    root.position.set(0, 0, 0);
    STATE.scene.add(root);
    cacheBones(root);
    label.textContent = 'Avatar ready';
    logStatus('Avatar ready');
  } catch (e) {
    label.textContent = 'Avatar load failed (add a VRM model)';
    logStatus(`Avatar load failed: ${String(e?.message || e)}`);
    return;
  }

  if (!STATE.ready) {
    STATE.ready = true;
    requestAnimationFrame(animate);
  }
}

function playToken(token) {
  const mount = ensureMount();
  if (!mount) return;
  const { label } = mount;

  const t = String(token || '').trim();
  if (!t) return;

  label.textContent = t;
  STATE.gesture = { name: t.toUpperCase(), t0: performance.now() };
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__signstream !== true) return;

  if (msg.type === 'AVATAR_INIT') {
    STATE.modelUrl = msg.modelUrl || null;
    void init(STATE.modelUrl);
  }

  if (msg.type === 'AVATAR_TOKENS') {
    const tokens = msg.tokens || [];
    const first = tokens.find((x) => x && typeof x === 'string' && !x.startsWith('FS:'));
    if (first) playToken(first);
  }
});
