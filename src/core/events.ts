/** Tiny typed event bus used to decouple gameplay systems. */
export type CrimeType =
  | 'speeding'
  | 'redLight'
  | 'reckless'
  | 'hitAndRun'
  | 'propertyDamage'
  | 'rammingCop'
  | 'evading';

export interface GameEvents {
  crime: { type: CrimeType; witnessed: boolean; heat: number };
  heatChanged: { heat: number; stars: number };
  pursuitStarted: { stars: number };
  pullover: { active: boolean };
  ticket: { fine: number };
  busted: { fine: number };
  escaped: { bonus: number; heat: number };
  cooldownStarted: {};
  spotted: {};
  wrecked: {};
  collision: { impulse: number; kind: 'static' | 'traffic' | 'cop' | 'prop' };
  propSmashed: { x: number; z: number };
  spiked: {};
  message: { text: string; sub?: string; color?: string; time?: number };
  cash: { delta: number; reason: string };
  jobStarted: { name: string };
  jobEnded: { name: string; success: boolean; reward: number };
  nitro: { active: boolean };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (set) for (const fn of [...set]) fn(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
