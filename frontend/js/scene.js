import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const CX = -45, CZ = 0, LOOP_R = 45;
const CRATERS = [[-20, -30, 9, 2], [-80, 25, 11, 2.4], [-45, 0, 14, 1.6], [-90, -40, 8, 1.8], [10, 30, 9, 2], [-10, 55, 7, 1.4], [-70, -70, 10, 2.2]];

export function height(x, z) {
  let h = Math.sin(x * 0.11) * Math.cos(z * 0.09) * 1.1 + Math.sin(x * 0.37 + z * 0.23) * 0.25;
  for (const [c, d, r, k] of CRATERS) {
    const q = Math.hypot(x - c, z - d) / r;
    if (q < 1) h -= k * (1 - q * q);
    else if (q < 1.3) h += k * 0.25 * (1 - (q - 1) / 0.3);
  }
  return h;
}

const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...o });
const mesh = (g, m) => new THREE.Mesh(g, m);

export class TwinScene {
  constructor() {
    const R = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    R.setPixelRatio(Math.min(devicePixelRatio, 2));
    const S = (this.scene = new THREE.Scene());
    S.background = new THREE.Color(0x05050a);
    S.fog = new THREE.Fog(0x05050a, 70, 260);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);
    this.camera.position.set(8, 6, 12);
    this.controls = new OrbitControls(this.camera, R.domElement);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 70;
    this.controls.minDistance = 4;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.time = 0;
    this.truthOn = false;
    this.simSpeed = 20;
    this._build();
    this.ro = new ResizeObserver(() => this._resize());
    this.clock = new THREE.Clock();
    this.state = null;
    this.truth = null;
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
    this.controls.autoRotateSpeed = 0.6;
    const P = this.rover.position;
    const off = interactive ? [6, 4.5, 9] : [-5, 3, 9];
    this.camera.position.set(P.x + off[0], P.y + off[1], P.z + off[2]);
    this.controls.target.set(P.x, P.y + 1, P.z);
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
    S.add(new THREE.AmbientLight(0xffe6cc, 0.55));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 2.4));
    sun.position.set(60, 50, 30);
    S.add(sun);
    S.add(sun.target);

    // terrain
    const tg = new THREE.PlaneGeometry(300, 300, 150, 150);
    tg.rotateX(-Math.PI / 2);
    tg.translate(CX, 0, CZ);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) tp.setY(i, height(tp.getX(i), tp.getZ(i)));
    tg.computeVertexNormals();
    S.add(mesh(tg, new THREE.MeshStandardMaterial({ color: 0x8b847b, flatShading: true, roughness: 1 })));

    // planned traverse
    const pts = [];
    for (let i = 0; i <= 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      const x = CX + Math.cos(a) * LOOP_R, z = CZ + Math.sin(a) * LOOP_R;
      pts.push(new THREE.Vector3(x, height(x, z) + 0.08, z));
    }
    this.route = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0xff9933, dashSize: 1.2, gapSize: 1.6, transparent: true, opacity: 0.35 }));
    this.route.computeLineDistances();
    S.add(this.route);

    // rocks, kept off the route
    const rg = new THREE.IcosahedronGeometry(1, 0);
    const rm = new THREE.MeshStandardMaterial({ color: 0x6b645c, flatShading: true, roughness: 1 });
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 160; i++) {
      const x = CX + (rnd() - 0.5) * 200, z = CZ + (rnd() - 0.5) * 200;
      if (Math.abs(Math.hypot(x - CX, z - CZ) - LOOP_R) < 4) continue;
      const r = 0.3 + rnd() * 1.1;
      const m = mesh(rg, rm);
      m.scale.set(r, r * 0.6, r);
      m.position.set(x, height(x, z) + r * 0.2, z);
      m.rotation.y = rnd() * 3;
      S.add(m);
    }
    // the boulder the rover parks behind in SHADE pose
    this.boulder = mesh(new THREE.IcosahedronGeometry(2.6, 1), rm);
    this.boulder.scale.set(1, 0.9, 1);
    this.boulder.visible = false;
    S.add(this.boulder);

    // sky
    const earth = (this.earth = mesh(new THREE.SphereGeometry(10, 48, 48), mat(0x2e7fb8, { emissive: 0x0a1f33, roughness: 0.8, fog: false })));
    earth.position.set(-150, 70, -230);
    S.add(earth);
    const land = mesh(new THREE.SphereGeometry(10.05, 48, 48), new THREE.MeshStandardMaterial({ color: 0x3e9b5a, roughness: 1, fog: false, transparent: true, opacity: 0.55 }));
    land.position.copy(earth.position);
    land.scale.set(1, 0.6, 1);
    S.add(land);
    this.land = land;
    const sd = mesh(new THREE.SphereGeometry(8, 24, 24), new THREE.MeshBasicMaterial({ color: 0xfff0c8, fog: false }));
    sd.position.set(260, 150, 120);
    S.add(sd);
    const sp = [];
    for (let i = 0; i < 2200; i++) {
      const u = Math.random() * 6.283, v = Math.acos(2 * Math.random() - 1);
      sp.push(800 * Math.sin(v) * Math.cos(u), Math.abs(800 * Math.cos(v)) + 10, 800 * Math.sin(v) * Math.sin(u));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    S.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xfff3df, size: 1.6, sizeAttenuation: false, fog: false })));

    this._buildRover();
    this._buildGhost();
    this._buildRelay();
  }

  _buildRover() {
    const rv = (this.rover = new THREE.Group());
    this.scene.add(rv);
    const body = (this.body = mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), mat(0xd9a43d, { metalness: 0.6, roughness: 0.35 })));
    body.position.y = 0.75;
    rv.add(body);
    const deck = mesh(new THREE.BoxGeometry(1.5, 0.06, 1.7), mat(0x3b2b1d, { metalness: 0.3 }));
    deck.position.y = 1.03;
    rv.add(deck);
    this.battery = mesh(new THREE.BoxGeometry(0.55, 0.22, 0.5), mat(0x2b2b30, { emissive: 0x000000 }));
    this.battery.position.set(-0.4, 1.17, 0.45);
    rv.add(this.battery);
    const panelPivot = (this.panel = new THREE.Group());
    panelPivot.position.set(0, 1.1, 0.2);
    const panel = mesh(new THREE.BoxGeometry(2.6, 0.04, 1.2), mat(0x1b2a6b, { metalness: 0.5, roughness: 0.25, emissive: 0x050a20 }));
    panel.position.set(0, 0.08, 0);
    panelPivot.add(panel);
    rv.add(panelPivot);
    const mast = mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 8), mat(0xdddddd));
    mast.position.set(0, 1.55, -0.8);
    rv.add(mast);
    const head = mesh(new THREE.BoxGeometry(0.4, 0.26, 0.26), mat(0xf2f2f2));
    head.position.set(0, 2.1, -0.8);
    rv.add(head);
    this.lens = mesh(new THREE.SphereGeometry(0.07, 12, 12), mat(0x111111, { emissive: 0x44ff66 }));
    this.lens.position.set(0, 2.1, -0.95);
    rv.add(this.lens);
    const dishPivot = (this.dish = new THREE.Group());
    dishPivot.position.set(0.55, 1.45, 0.75);
    const dish = mesh(new THREE.SphereGeometry(0.34, 18, 8, 0, 6.283, 0, 1.4), mat(0xeeeeee, { side: THREE.DoubleSide }));
    dish.rotation.x = Math.PI;
    dishPivot.add(dish);
    rv.add(dishPivot);
    this.lga = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8), mat(0xcccccc, { emissive: 0x000000 }));
    this.lga.position.set(-0.6, 1.4, -0.6);
    rv.add(this.lga);
    this.wheels = [];
    for (const x of [-1, 1]) for (const z of [-0.85, 0, 0.85]) {
      const w = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 16), mat(0x2a2521, { roughness: 0.9 }));
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.38, z);
      rv.add(w);
      this.wheels.push(w);
    }
    const pole = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 6), mat(0xdddddd));
    pole.position.set(0, 2.45, -0.8);
    rv.add(pole);
    [[0xff9933, 2.67], [0xffffff, 2.55], [0x3ecf6a, 2.43]].forEach(([c, y]) => {
      const f = mesh(new THREE.PlaneGeometry(0.3, 0.12), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
      f.position.set(0.16, y, -0.8);
      rv.add(f);
    });
    this.head = new THREE.PointLight(0xfff0c8, 6, 16, 1);
    this.head.position.set(0, 1.3, -1.6);
    rv.add(this.head);
    this.alarm = new THREE.PointLight(0xff4d3a, 0, 10, 1);
    this.alarm.position.set(0, 2, 0);
    rv.add(this.alarm);
    this.cone = mesh(new THREE.ConeGeometry(2.2, 6, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff9933, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    this.cone.rotation.x = Math.PI / 2;
    this.cone.position.set(0, 2.1, -3.8);
    rv.add(this.cone);
  }

  _buildGhost() {
    const g = (this.ghost = new THREE.Group());
    const m = new THREE.MeshBasicMaterial({ color: 0x5cc8ff, wireframe: true, transparent: true, opacity: 0.55 });
    const b = mesh(new THREE.BoxGeometry(1.7, 0.6, 2.3), m);
    b.position.y = 0.75;
    g.add(b);
    const mast = mesh(new THREE.BoxGeometry(0.1, 1.2, 0.1), m);
    mast.position.set(0, 1.6, -0.8);
    g.add(mast);
    g.visible = false;
    this.scene.add(g);
  }

  _buildRelay() {
    const sat = (this.sat = new THREE.Group());
    sat.add(mesh(new THREE.BoxGeometry(1.2, 1.2, 1.6), mat(0xd9a43d, { metalness: 0.6 })));
    for (const x of [-1, 1]) {
      const pn = mesh(new THREE.BoxGeometry(2.4, 0.06, 1.2), mat(0x1b2a6b, { emissive: 0x050a20 }));
      pn.position.x = x * 1.9;
      sat.add(pn);
    }
    this.scene.add(sat);
    const beam = (c) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: c, transparent: true, fog: false }));
      l.frustumCulled = false;
      this.scene.add(l);
      return l;
    };
    this.b1 = beam(0xff9933);
    this.b2 = beam(0x3ecf6a);
  }

  setState(twin, truth, simSpeed) {
    this.state = twin;
    this.truth = truth;
    this.simSpeed = simSpeed;
    if (!this.pose) this.pose = { x: twin.x, z: twin.z, h: twin.heading };
  }

  _update(dt) {
    const s = this.state, t = this.time;
    const P = this.rover.position;
    if (s) {
      const k = 1 - Math.exp(-dt * 5);
      const prev = { x: this.pose.x, z: this.pose.z };
      this.pose.x += (s.x - this.pose.x) * k;
      this.pose.z += (s.z - this.pose.z) * k;
      let dh = s.heading - this.pose.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.pose.h += dh * k;
      const moved = Math.hypot(this.pose.x - prev.x, this.pose.z - prev.z);
      const before = P.clone();
      P.set(this.pose.x, height(this.pose.x, this.pose.z) + 0.02, this.pose.z);
      this.rover.rotation.y = this.pose.h;
      this.wheels.forEach((w) => (w.rotation.x -= moved / 0.38));
      if (this.controls.enabled) {
        const d = P.clone().sub(before);
        this.camera.position.add(d);
      }
      this.controls.target.lerp(new THREE.Vector3(P.x, P.y + 1, P.z), 1 - Math.exp(-dt * 4));

      // fault visuals driven by the twin state
      const hot = Math.max(0, Math.min(1, (s.t_av - 40) / 35));
      this.body.material.emissive.setRGB(hot * 0.9, hot * 0.18, 0);
      const bh = Math.max(0, Math.min(1, (s.t_bat - 35) / 25));
      this.battery.material.emissive.setRGB(bh * (0.7 + 0.3 * Math.sin(t * 6)), bh * 0.1, 0);
      this.head.intensity = s.dead ? 0 : 6 * Math.min(1, s.soc / 0.3) * (s.soc < 0.25 && Math.random() < 0.3 ? 0.2 : 1);
      const att = s.att_err;
      const lensC = att < 2 ? 0x44ff66 : att < 8 ? 0xffb02e : (Math.sin(t * 10) > 0 ? 0xff2200 : 0x220000);
      this.lens.material.emissive.setHex(lensC);
      this.cone.material.color.setHex(att < 2 ? 0xff9933 : 0xff4d3a);
      this.cone.material.opacity = 0.04 + 0.12 * Math.max(0, 1 - att / 15);
      const wob = Math.min(att, 25) * Math.PI / 180;
      this.dish.rotation.set(-0.9 + Math.sin(t * 1.3) * wob, Math.cos(t * 0.9) * wob, 0);
      this.dish.visible = s.cfg.antenna === "HGA";
      this.lga.material.emissive.setHex(s.cfg.antenna === "LGA" ? 0x3ecf6a : 0x000000);
      const tilt = s.cfg.pose === "SUN" ? -0.55 : 0;
      this.panel.rotation.x += (tilt - this.panel.rotation.x) * Math.min(1, dt * 2);
      const alarm = s.cfg.mode === "SAFE" || s.dead;
      this.alarm.color.setHex(s.dead ? 0x555555 : 0xff4d3a);
      this.alarm.intensity = alarm ? 3 + 3 * Math.sin(t * 6) : 0;
      this.sun.intensity = 2.4 * (1 - 0.8 * s.shade);
      this.boulder.visible = s.shade > 0.05;
      if (this.boulder.visible) {
        const bx = P.x + 2.8, bz = P.z + 1.6;
        this.boulder.position.set(bx, height(bx, bz) + 1.2, bz);
      }

      // relay orbiter and links
      this.sat.position.set(P.x + Math.cos(t * 0.15) * 14, P.y + 16 + Math.sin(t * 0.3), P.z - 10 + Math.sin(t * 0.15) * 6);
      this.sat.rotation.y = t * 0.2;
      this.rover.updateMatrixWorld();
      const ant = this.rover.localToWorld(new THREE.Vector3(0.55, 1.5, 0.75));
      setLine(this.b1, ant, this.sat.position);
      setLine(this.b2, this.sat.position, this.earth.position);
      const m = s.margin;
      const on = s.down_ok && (m > -12 || Math.random() < 0.5);
      this.b1.visible = on;
      this.b2.visible = on;
      this.b1.material.opacity = Math.max(0.2, Math.min(1, (m + 21) / 25));
      this.b1.material.color.setHex(m > 3 ? 0xff9933 : 0xff4d3a);
    }
    const tr = this.truth;
    this.ghost.visible = !!(this.truthOn && tr);
    if (this.ghost.visible) {
      this.ghost.position.set(tr.x, height(tr.x, tr.z) + 0.02, tr.z);
      this.ghost.rotation.y = tr.heading;
    }
    this.earth.rotation.y += dt * 0.02;
    this.land.rotation.y += dt * 0.02;
  }
}

function setLine(l, a, b) {
  const p = l.geometry.attributes.position;
  p.setXYZ(0, a.x, a.y, a.z);
  p.setXYZ(1, b.x, b.y, b.z);
  p.needsUpdate = true;
}
