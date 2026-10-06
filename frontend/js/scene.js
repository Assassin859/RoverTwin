import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const EARTH_R = 6.4;
const ORBIT_R = 9.2;
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...o });
const mesh = (g, m) => new THREE.Mesh(g, m);

/** Legacy height helper kept for any stray imports. */
export function height() {
  return 0;
}

export class TwinScene {
  constructor() {
    const R = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    R.setPixelRatio(Math.min(devicePixelRatio, 2));
    const S = (this.scene = new THREE.Scene());
    S.background = new THREE.Color(0x02040a);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(0, 8, 22);
    this.controls = new OrbitControls(this.camera, R.domElement);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 80;
    this.controls.minDistance = 10;
    this.controls.target.set(0, 0, 0);
    this.time = 0;
    this.truthOn = false;
    this.simSpeed = 20;
    this.state = null;
    this.truth = null;
    this._build();
    this.ro = new ResizeObserver(() => this._resize());
    this.clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.time += dt;
      this._update(dt);
      this.controls.update();
      R.render(S, this.camera);
    };
    loop();
  }

  mount(el, { interactive = true } = {}) {
    if (this.host) this.ro.unobserve(this.host);
    this.host = el;
    el.appendChild(this.renderer.domElement);
    this.ro.observe(el);
    this.controls.enabled = interactive;
    this.controls.autoRotate = !interactive;
    this.controls.autoRotateSpeed = 0.35;
    this.camera.position.set(0, 8, 22);
    this.controls.target.set(0, 0, 0);
    this._resize();
  }

  _resize() {
    if (!this.host) return;
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = this.camera.aspect < 1 ? 66 : 50;
    this.camera.updateProjectionMatrix();
  }

  _build() {
    const S = this.scene;
    S.add(new THREE.AmbientLight(0x6688aa, 0.35));
    const sun = (this.sunLight = new THREE.DirectionalLight(0xfff5e0, 2.2));
    sun.position.set(40, 10, 0);
    S.add(sun);

    // stars
    const sp = [];
    for (let i = 0; i < 2800; i++) {
      const u = Math.random() * 6.283, v = Math.acos(2 * Math.random() - 1);
      const r = 400 + Math.random() * 200;
      sp.push(r * Math.sin(v) * Math.cos(u), r * Math.cos(v), r * Math.sin(v) * Math.sin(u));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    S.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xddeeff, size: 1.4, sizeAttenuation: false })));

    // Earth
    this.earth = mesh(new THREE.SphereGeometry(EARTH_R, 64, 64), mat(0x1a5f9e, { roughness: 0.85, metalness: 0.05 }));
    S.add(this.earth);
    const land = mesh(new THREE.SphereGeometry(EARTH_R + 0.02, 64, 64),
      new THREE.MeshStandardMaterial({ color: 0x2d8a4e, transparent: true, opacity: 0.45, roughness: 1 }));
    land.scale.set(1, 0.92, 1);
    this.earth.add(land);
    // night side hint via emissive rim
    this.terminator = mesh(new THREE.SphereGeometry(EARTH_R + 0.05, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x000510, transparent: true, opacity: 0.35, side: THREE.BackSide }));
    S.add(this.terminator);

    // orbit track
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * ORBIT_R, 0, Math.sin(a) * ORBIT_R));
    }
    this.orbitLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.55 }),
    );
    S.add(this.orbitLine);

    // eclipse arc highlight (approx half opposite sun)
    const ePts = [];
    for (let i = 0; i <= 40; i++) {
      const a = Math.PI * 0.5 + (i / 40) * Math.PI * 0.7;
      ePts.push(new THREE.Vector3(Math.cos(a) * ORBIT_R, 0.05, Math.sin(a) * ORBIT_R));
    }
    this.eclipseArc = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ePts),
      new THREE.LineBasicMaterial({ color: 0x334466, transparent: true, opacity: 0.9 }),
    );
    S.add(this.eclipseArc);

    // Ground stations
    this.gs = new THREE.Group();
    S.add(this.gs);
    for (const [lat, lon, col] of [[0.3, 0.2, 0xffaa33], [-0.4, 1.8, 0x66ff99], [0.6, -2.0, 0xff6688]]) {
      const g = mesh(new THREE.SphereGeometry(0.18, 12, 12), mat(col, { emissive: col, emissiveIntensity: 0.6 }));
      const r = EARTH_R + 0.12;
      g.position.set(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon));
      this.gs.add(g);
      const cone = mesh(new THREE.ConeGeometry(0.8, 2.2, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
      cone.position.copy(g.position).multiplyScalar(1.15);
      cone.lookAt(0, 0, 0);
      cone.rotateX(Math.PI);
      this.gs.add(cone);
    }

    this._buildSat();
    this._buildGhost();

    // Sun disc
    const sunDisc = mesh(new THREE.SphereGeometry(1.4, 24, 24), new THREE.MeshBasicMaterial({ color: 0xfff4c8 }));
    sunDisc.position.set(48, 4, 0);
    S.add(sunDisc);

    // Aliases used by older UI code paths
    this.rover = this.sat;
    this.body = this.bus;
    this.panel = this.panels;
    this.dish = this.antenna;
    this.route = this.orbitLine;
    this.boulder = new THREE.Object3D();
    this.relay = new THREE.Object3D();
    this.earthDeco = this.earth;
  }

  _buildSat() {
    const sat = (this.sat = new THREE.Group());
    this.scene.add(sat);
    const bus = (this.bus = mesh(new THREE.BoxGeometry(0.55, 0.4, 0.7), mat(0xc8cdd6, { metalness: 0.55, roughness: 0.35 })));
    sat.add(bus);
    this.battery = mesh(new THREE.BoxGeometry(0.2, 0.15, 0.25), mat(0x2a2a30, { emissive: 0x000000 }));
    this.battery.position.set(-0.2, 0.05, 0.15);
    sat.add(this.battery);
    const panels = (this.panels = new THREE.Group());
    const pMat = mat(0x1a3377, { metalness: 0.4, roughness: 0.3, emissive: 0x0a1540 });
    const left = mesh(new THREE.BoxGeometry(1.6, 0.03, 0.55), pMat);
    left.position.set(-1.1, 0, 0);
    const right = mesh(new THREE.BoxGeometry(1.6, 0.03, 0.55), pMat);
    right.position.set(1.1, 0, 0);
    panels.add(left, right);
    sat.add(panels);
    const ant = (this.antenna = new THREE.Group());
    ant.position.set(0, 0.15, -0.4);
    const boom = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 8), mat(0xdddddd));
    boom.rotation.x = Math.PI / 2;
    boom.position.z = -0.1;
    ant.add(boom);
    const dish = mesh(new THREE.SphereGeometry(0.18, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(0xe8e8e8, { metalness: 0.6, side: THREE.DoubleSide }));
    dish.rotation.x = Math.PI;
    dish.position.z = -0.28;
    ant.add(dish);
    sat.add(ant);
    this.lens = mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.12, 16), mat(0x111111, { emissive: 0x44ff66 }));
    this.lens.rotation.x = Math.PI / 2;
    this.lens.position.set(0, -0.22, 0.1);
    sat.add(this.lens);
    this.beam = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -EARTH_R, 0)]),
      new THREE.LineBasicMaterial({ color: 0x66ffaa, transparent: true, opacity: 0.35 }),
    );
    sat.add(this.beam);
    this.passRing = mesh(new THREE.RingGeometry(0.9, 1.05, 32),
      new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.0, side: THREE.DoubleSide }));
    this.passRing.rotation.x = -Math.PI / 2;
    sat.add(this.passRing);
  }

  _buildGhost() {
    this.ghost = this.sat.clone(true);
    this.ghost.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.25;
        o.material.depthWrite = false;
      }
    });
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  setState(state, truth, simSpeed) {
    this.state = state;
    this.truth = truth;
    if (simSpeed != null) this.simSpeed = simSpeed;
  }

  setTruth(on) {
    this.truthOn = !!on;
    if (this.ghost) this.ghost.visible = this.truthOn;
  }

  _place(obj, angle) {
    obj.position.set(Math.cos(angle) * ORBIT_R, 0, Math.sin(angle) * ORBIT_R);
    obj.lookAt(0, 0, 0);
    obj.rotateY(Math.PI);
  }

  _update() {
    const s = this.state;
    if (!s) return;
    const angle = s.orbit_angle ?? s.heading ?? 0;
    this._place(this.sat, angle);
    if (this.truthOn && this.truth) {
      const ta = this.truth.heading ?? angle;
      this._place(this.ghost, ta);
      this.ghost.visible = true;
    } else if (this.ghost) this.ghost.visible = false;

    // Sun from +X; eclipse when sat is on -X side roughly
    const eclipse = !!s.eclipse;
    const pass = !!s.gs_pass;
    this.panels.rotation.z = eclipse ? 0.15 : Math.sin(this.time * 0.4) * 0.05;
    this.antenna.rotation.y = pass ? Math.sin(this.time * 2) * 0.1 : 0.4;
    this.passRing.material.opacity = pass ? 0.55 + 0.25 * Math.sin(this.time * 6) : 0.0;
    this.beam.visible = pass;
    if (pass) {
      const pos = this.sat.position;
      this.beam.geometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3(-pos.x, -pos.y, -pos.z).multiplyScalar(0.55)]);
    }

    // Bus health tint from battery / heat if available
    const soc = s.soc ?? 0.8;
    const hot = (s.t_av ?? 25) > 50;
    if (this.battery?.material) {
      this.battery.material.emissive = new THREE.Color(soc < 0.25 ? 0xff3333 : hot ? 0xff8800 : 0x114422);
      this.battery.material.emissiveIntensity = soc < 0.25 || hot ? 0.7 : 0.15;
    }
    if (this.lens?.material) {
      this.lens.material.emissive = new THREE.Color(s.cfg?.payload === false || s.cfg?.drive === false ? 0x444444 : 0x44ff66);
    }

    this.earth.rotation.y += 0.02 * Math.min(this.simSpeed, 60) / 60 * 0.016;
    this.terminator.position.copy(this.earth.position);
  }
}
