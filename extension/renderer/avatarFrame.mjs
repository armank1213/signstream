import * as THREE from '../lib/three.module.min.js';
import { GLTFLoader } from '../lib/GLTFLoader.js';

const state = {
  scene: null,
  camera: null,
  renderer: null,
  avatar: null,
  bones: {},
  gesture: { name: null, t0: 0 },
};

const root = document.getElementById('root');
const canvas = document.createElement('canvas');
const label = document.createElement('div');
label.id = 'label';
root.appendChild(canvas);
root.appendChild(label);

function postStatus(text) {
  try {
    parent.postMessage({ __signstream: true, type: 'AVATAR_STATUS', status: text }, '*');
  } catch {}
}

function findFirstByName(obj, patterns) {
  if (!obj) return null;
  const pats = (patterns || []).map((p) => String(p).toLowerCase());
  let best = null;
  obj.traverse((o) => {
    if (!o || !o.name) return;
    const n = String(o.name).toLowerCase();
    if (pats.some((p) => n.includes(p))) best = o;
  });
  return best;
}

function cacheBones(rootObj) {
  const rightHand = findFirstByName(rootObj, [
    'r_hand',
    'righthand',
    'j_bip_r_hand',
    'hand_r',
    'rhand',
    'handright',
    'hand',
  ]);
  const leftHand = findFirstByName(rootObj, [
    'l_hand',
    'lefthand',
    'j_bip_l_hand',
    'hand_l',
    'lhand',
    'handleft',
    'hand',
  ]);
  const head = findFirstByName(rootObj, ['head']);
  state.bones = { rightHand, leftHand, head };
}

function resetRotation(o, s = 0.15) {
  if (!o || !o.rotation) return;
  o.rotation.x *= 1 - s;
  o.rotation.y *= 1 - s;
  o.rotation.z *= 1 - s;
}

function applyGesture(name, t) {
  const { rightHand, leftHand, head } = state.bones || {};
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
  if (!state.renderer || !state.scene || !state.camera) return;

  if (state.avatar) {
    state.avatar.rotation.y = Math.sin(Date.now() / 2000) * 0.15;
  }

  if (state.gesture?.name) {
    const dur = 0.85;
    const t = Math.min(1, (performance.now() - state.gesture.t0) / (dur * 1000));
    applyGesture(state.gesture.name, t);
    if (t >= 1) state.gesture.name = null;
  }

  const w = canvas.clientWidth || 220;
  const h = canvas.clientHeight || 220;
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();

  state.renderer.render(state.scene, state.camera);
  requestAnimationFrame(animate);
}

async function init(modelUrl) {
  label.textContent = 'Loading avatar…';

  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  state.camera.position.set(0, 1.35, 2.2);
  state.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  state.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  hemi.position.set(0, 2, 0);
  state.scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 2, 1);
  state.scene.add(dir);

  if (!modelUrl) {
    label.textContent = 'Missing avatar model';
    postStatus('Missing avatar model');
    return;
  }

  const loader = new GLTFLoader();
  let gltf;
  try {
    gltf = await loader.loadAsync(modelUrl);
  } catch (e) {
    label.textContent = 'Avatar load failed';
    postStatus(`Avatar load failed: ${String(e?.message || e)}`);
    return;
  }

  state.avatar = gltf.scene;
  state.avatar.position.set(0, 0, 0);
  state.scene.add(state.avatar);
  cacheBones(state.avatar);

  label.textContent = 'Avatar ready';
  postStatus('Avatar ready');
  requestAnimationFrame(animate);
}

function playToken(token) {
  const t = String(token || '').trim();
  if (!t) return;
  label.textContent = t;
  state.gesture = { name: t.toUpperCase(), t0: performance.now() };
}

window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const msg = event.data;
  if (!msg || msg.__signstream !== true) return;

  if (msg.type === 'AVATAR_INIT') {
    void init(msg.modelUrl);
  }
  if (msg.type === 'AVATAR_TOKENS') {
    const tokens = msg.tokens || [];
    const first = tokens.find((x) => x && typeof x === 'string' && !x.startsWith('FS:'));
    if (first) playToken(first);
  }
});
