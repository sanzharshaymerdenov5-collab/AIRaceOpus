import RAPIER from '@dimforge/rapier3d-compat';

/** Collision group bits. */
export const G = {
  STATIC: 0x0001,
  PLAYER: 0x0002,
  TRAFFIC: 0x0004,
  COP: 0x0008,
  PROP: 0x0010,
  SENSOR: 0x0020,
  GROUND: 0x0040,
  ALL: 0xffff,
};
export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);

export type EntityKind = 'ground' | 'static' | 'player' | 'traffic' | 'cop' | 'prop' | 'spike';
export interface EntityRef {
  kind: EntityKind;
  ref?: unknown;
}

let initPromise: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!initPromise) initPromise = RAPIER.init();
  return initPromise;
}

/** Thin wrapper around a Rapier world with an entity registry for collider handles. */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  private registry = new Map<number, EntityRef>();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(gravity = -22) {
    this.world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
    this.world.timestep = 1 / 60;
    this.events = new RAPIER.EventQueue(true);
  }

  register(collider: RAPIER.Collider, ent: EntityRef) {
    this.registry.set(collider.handle, ent);
  }
  unregister(collider: RAPIER.Collider) {
    this.registry.delete(collider.handle);
  }
  entity(handle: number): EntityRef | undefined {
    return this.registry.get(handle);
  }

  addGround(halfSize: number) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize, 0.5, halfSize).setFriction(0.6).setCollisionGroups(groups(G.GROUND, G.ALL)),
      body,
    );
    this.register(col, { kind: 'ground' });
    return col;
  }

  /** Static axis-aligned (optionally rotated about Y) box. */
  addStaticBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, rotY = 0) {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    if (rotY) desc.setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) });
    const body = this.world.createRigidBody(desc);
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.2).setCollisionGroups(groups(G.STATIC, G.ALL)),
      body,
    );
    this.register(col, { kind: 'static' });
    return col;
  }

  step() {
    this.world.step(this.events);
  }

  /** Line-of-sight check against static geometry only. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return true;
    this.ray.origin = { x: ax, y: ay, z: az };
    this.ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = this.world.castRay(this.ray, len, true, undefined, groups(G.ALL, G.STATIC));
    return !hit;
  }

  /** Forward ray used by AI for obstacle sensing. Returns distance or Infinity. */
  castForward(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dz: number,
    maxDist: number,
    exclude: RAPIER.RigidBody,
    mask = G.STATIC | G.PLAYER | G.TRAFFIC | G.COP,
  ): { dist: number; handle: number } | null {
    this.ray.origin = { x: ox, y: oy, z: oz };
    this.ray.dir = { x: dx, y: 0, z: dz };
    const hit = this.world.castRay(this.ray, maxDist, true, undefined, groups(G.ALL, mask), undefined, exclude);
    return hit ? { dist: hit.timeOfImpact, handle: hit.collider.handle } : null;
  }
}
