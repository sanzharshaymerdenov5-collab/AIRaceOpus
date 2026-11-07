import type { Axis, Intersection } from './CityLayout';

export type LightState = 'green' | 'yellow' | 'red';

/**
 * Two-phase signal controller per intersection.
 * Cycle (24 s): Z-axis green 9 / yellow 2 / all-red 1 / X-axis green 9 / yellow 2 / all-red 1
 */
export const LIGHT_CYCLE = 24;

export function lightState(I: Intersection, axis: Axis, time: number): LightState {
  if (!I.hasLights) return 'green';
  const t = (((time + I.lightOffset) % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
  const phaseAxis: Axis = t < 12 ? 'z' : 'x';
  const p = t % 12;
  if (axis !== phaseAxis) return 'red';
  if (p < 9) return 'green';
  if (p < 11) return 'yellow';
  return 'red';
}
