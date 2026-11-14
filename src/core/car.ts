/** How one driver behaves. Distances in metres, time in seconds. */
export interface Driver {
  maxSpeed: number;
  maxAccel: number;
  maxBrake: number;
  /** Gap kept to the car ahead when standing still. */
  standGap: number;
  /** Extra gap per unit of speed, in seconds. */
  headway: number;
  /** How quickly acceleration rises once the gap is larger than needed. */
  accelSmoothing: number;
  /** How quickly braking rises once the gap is smaller than needed. */
  brakeSmoothing: number;
}

export const CAR_LENGTH = 4.5;

/** A driver from a roll in [0, 1): higher rolls drive faster and keep more distance. */
export function makeDriver(roll: number): Driver {
  return {
    maxSpeed: 11 + roll * 3,
    maxAccel: 2.2 + roll * 0.8,
    maxBrake: 8 + roll * 2,
    standGap: 2 + roll,
    headway: 1.0 + roll * 0.3,
    accelSmoothing: 0.4 + roll * 0.2,
    brakeSmoothing: 0.5 + roll * 0.2,
  };
}

/** Braking that a driver plans for when closing in on something slower. */
export const PLANNED_BRAKE = 3;

/**
 * The gap this driver wants: a standing gap, a time headway, and the extra
 * distance needed to slow down to the speed of whatever is ahead.
 */
export function safeGap(driver: Driver, speed: number, leadSpeed = speed): number {
  const closing = Math.max(speed ** 2 - leadSpeed ** 2, 0) / (2 * PLANNED_BRAKE);
  return driver.standGap + driver.headway * speed + closing;
}

/**
 * The car-following rule. Let x be the gap to whatever is ahead minus the gap the
 * driver wants. Then
 *
 *   acceleration = limit * (2 / (1 + e^(-k x)) - 1)
 *
 * which is a sigmoid shifted to pass through zero: no reaction at the wanted gap,
 * full throttle far behind, full brake when much too close. `limit` and `k` are
 * the acceleration values for x > 0 and the braking values for x < 0.
 * `leadSpeed` is the speed of the thing ahead (0 for a stop line).
 */
export function acceleration(
  driver: Driver,
  gap: number,
  speed: number,
  leadSpeed = speed,
): number {
  if (gap === Number.POSITIVE_INFINITY) return driver.maxAccel;
  const x = gap - safeGap(driver, speed, leadSpeed);
  const limit = x >= 0 ? driver.maxAccel : driver.maxBrake;
  const k = x >= 0 ? driver.accelSmoothing : driver.brakeSmoothing;
  return limit * (2 / (1 + Math.exp(-k * x)) - 1);
}
