'use strict';
/*
 * Shared pusher table — authoritative server-side physics (cannon-es).
 * ONE instance = the single table everyone sees. The server steps it, and
 * broadcasts coin transforms to all clients (who only render).
 *
 * Layout (looking from the player's side):
 *   - a static floor (the shelf)
 *   - left/right/back static walls
 *   - a kinematic PUSHER that slides back-and-forth in Z, shoving the pile
 *   - the FRONT edge is open: coins pushed past frontEdgeZ fall off = WIN
 *   - coins that fall below the shelf on the sides are LOST
 */
const CANNON = require('cannon-es');
const { TABLE } = require('./config');

let _id = 1;

class Table {
  constructor() {
    // Stronger FORWARD tilt (+Z) like a real coin pusher: coins reliably drift
    // to the front and fall off (higher collection ≈ RTP), no violent shove.
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -17, 4.2) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    this.world.solver.iterations = 20; // stabler stacking, less tunneling

    const mat = new CANNON.Material('m');
    const cc = new CANNON.ContactMaterial(mat, mat, { friction: 0.4, restitution: 0.05 });
    this.world.addContactMaterial(cc);
    this.mat = mat;

    const W = TABLE.width, D = TABLE.depth;
    // floor (thick so slammed coins can't tunnel through; top stays at y=0)
    this._addBox(0, -1.5, 0, W, 3, D, mat);           // shelf top at y=0
    // back wall + sides (front open). Tall so the strong pusher can't launch
    // coins over them — coins leave via the FRONT (win) instead of the void.
    this._addBox(0, 6, -D / 2 - 0.5, W + 2, 14, 2, mat);   // back (thick)
    this._addBox(-W / 2 - 0.5, 6, 0, 2, 14, D, mat);       // left (thick)
    this._addBox(W / 2 + 0.5, 6, 0, 2, 14, D, mat);        // right (thick)

    // kinematic pusher — a SOLID plate that retracts fully to the back wall and
    // slides a long way forward to shove the pile off the front lip.
    const PLATE_HALF_D = 2.0;                 // thicker = solid, no coins slip through
    this.pusher = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: mat });
    this.pusher.addShape(new CANNON.Box(new CANNON.Vec3(W / 2, 2.5, PLATE_HALF_D)));
    this._pusherBackZ = -D / 2 + PLATE_HALF_D; // retracted = back face touches the back wall
    this.pusher.position.set(0, 0.2, this._pusherBackZ);
    this.world.addBody(this.pusher);
    this._t = 0;

    this.coins = new Map(); // id -> { body, value, owner, ownerName }
  }

  _addBox(x, y, z, w, h, d, mat) {
    const b = new CANNON.Body({ mass: 0, material: mat });
    b.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)));
    b.position.set(x, y, z);
    this.world.addBody(b);
    return b;
  }

  /** Drop a coin at the back for `owner`, carrying a pre-decided `value`. */
  dropCoin(owner, ownerName, value) {
    if (this.coins.size >= TABLE.maxCoins) return null;
    const id = _id++;
    const body = new CANNON.Body({
      mass: 1, material: this.mat, allowSleep: true,
      sleepSpeedLimit: 0.4, sleepTimeLimit: 0.5,
    });
    const s = new CANNON.Cylinder(TABLE.coinRadius, TABLE.coinRadius, TABLE.coinThickness, 12);
    const q = new CANNON.Quaternion(); q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI / 2);
    body.addShape(s, new CANNON.Vec3(0, 0, 0), q);
    const x = (this._rng01(id) - 0.5) * (TABLE.width - 2);
    // drop just IN FRONT of the retracted pusher so it can push them forward
    const z = -TABLE.depth / 2 + 4.5 + this._rng01(id * 7) * 3;
    body.position.set(x, TABLE.dropY, z);
    body.linearDamping = 0.12; body.angularDamping = 0.5;
    this.world.addBody(body);
    this.coins.set(id, { body, value: value | 0, owner, ownerName });
    return id;
  }

  _rng01(n) { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); }

  /**
   * Advance the sim by dt seconds. Returns { wins: [{owner,ownerName,value,id}], removed: [id] }
   * for coins that fell off the front (win) or off the sides (lost).
   */
  step(dt) {
    // oscillate pusher in Z (fully back → far forward)
    this._t += dt;
    const travel = TABLE.pusherTravel;
    const z = this._pusherBackZ + (Math.sin(this._t * TABLE.pusherSpeed) * 0.5 + 0.5) * travel;
    const prevZ = this.pusher.position.z;
    this.pusher.position.z = z;
    this.pusher.velocity.z = (z - prevZ) / dt; // so it shoves coins

    this.world.step(1 / TABLE.stepHz, dt, 3);

    // clamp coin speeds so a hard shove can't fling them through colliders
    const MAXV = 18;
    for (const c of this.coins.values()) {
      const v = c.body.velocity;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (sp > MAXV) { const k = MAXV / sp; v.x *= k; v.y *= k; v.z *= k; }
    }

    const wins = [], removed = [];
    for (const [id, c] of this.coins) {
      const p = c.body.position;
      // fell off the FRONT lip → win for the owner
      if (p.z > TABLE.frontEdgeZ && p.y < -1) {
        wins.push({ id, owner: c.owner, ownerName: c.ownerName, value: c.value });
        this._remove(id, c); continue;
      }
      // fell off a side or the back into the void → lost
      if (p.y < -6 || Math.abs(p.x) > TABLE.width) {
        removed.push(id); this._remove(id, c);
      }
    }
    return { wins, removed };
  }

  _remove(id, c) { this.world.removeBody(c.body); this.coins.delete(id); }

  /** Snapshot for broadcast: compact array of coin transforms. */
  snapshot() {
    const out = [];
    for (const [id, c] of this.coins) {
      const p = c.body.position, q = c.body.quaternion;
      out.push([
        id,
        +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3),
        c.value ? 1 : 0,          // 1 = prize coin, 0 = empty (client picks look)
      ]);
    }
    return {
      coins: out,
      pusherZ: +this.pusher.position.z.toFixed(2),
    };
  }
}

module.exports = { Table };
