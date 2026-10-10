// Models of the game in the browser: /api/models/<hash>.glb (exported once by
// the Studio, in GTA V's axes), loaded once and shared by every object that
// uses them (clones share geometry and materials).
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { modelUrl } from './stream.js';

export class Models {
  constructor() {
    this.loader = new GLTFLoader();
    this.cache = new Map();  // "<model>|<lod>" -> Promise<THREE.Group | null>
  }

  // low: streaming of the world around the camera. It goes behind what the user
  // asked for, in the browser's queue and on the server (see ExportSlots.cs).
  load(model, lod = 'high', tex = 512, low = false) {
    const key = `${model}|${lod}|${tex}`;
    if (!this.cache.has(key)) {
      const url = modelUrl(model, lod, tex, low);
      this.cache.set(key, fetch(url, low ? { priority: 'low' } : { priority: 'high' })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((buf) => (buf ? this.loader.parseAsync(buf, '') : null))
        .then((gltf) => {
          if (!gltf) return null;
          gltf.scene.traverse((c) => {
            c.userData.shared = true;  // never disposed with one object
            if (c.isMesh) {
              c.material.roughness = 0.9;
              c.material.metalness = 0;
              // Decals lie on other surfaces: drawn a little in front of them.
              if (/decal/i.test(c.material.name)) {
                c.material.polygonOffset = true;
                c.material.polygonOffsetFactor = -2;
                c.material.depthWrite = false;
              }
            }
          });
          return gltf.scene;
        })
        .catch(() => null));
    }
    return this.cache.get(key);
  }

  // A copy of the model for one object (null when the game has none).
  async instance(model, lod = 'high') {
    const scene = await this.load(model, lod);
    return scene ? scene.clone(true) : null;
  }

  clear() {
    this.cache.clear();
  }
}
