/**
 * Can the user see real clouds right now? Two inputs:
 * - time of day: the sun's elevation (NOAA solar position formulas, no library);
 * - indoors vs. outdoors: an on-device scene classifier on the camera frame.
 * Indoors (day or night) the camera view shows nothing; outdoors at night it draws virtual
 * clouds and stops camera cloud matching. Pure functions; DriftApp drives the tracker.
 */

const RAD = Math.PI / 180;

/** Sun elevation above the horizon in degrees (no refraction), accurate to ~0.1° for 1950-2050. */
export function sunElevationDeg(date: Date, latitude: number, longitude: number): number {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eqTimeMin =
    (4 / RAD) *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const solarMin = (((utcMin + eqTimeMin + 4 * longitude) % 1440) + 1440) % 1440;
  const hourAngle = solarMin / 4 - 180;
  const cosZenith = Math.sin(latitude * RAD) * Math.sin(decl) + Math.cos(latitude * RAD) * Math.cos(decl) * Math.cos(hourAngle * RAD);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / RAD;
}

/** Clouds are visible from civil dawn to civil dusk (sun above -6°), with a ±1° band against flicker. */
export function isDaylight(sunElevation: number, wasDaylight: boolean | null): boolean {
  if (wasDaylight === null) return sunElevation >= -6;
  return wasDaylight ? sunElevation >= -7 : sunElevation >= -5;
}

/**
 * Evidence for being outdoors, -1 (indoors) to +1 (outdoors), from the on-device scene
 * classifier's P(indoor) (sceneClassifier.ts). Null when there is no classification yet.
 */
export function outdoorScore(pIndoor: number | null): number | null {
  return pIndoor === null ? null : Math.max(-1, Math.min(1, 1 - 2 * pIndoor));
}

/** "checking": daytime, but no scene reading yet, so indoor/outdoor is unknown. */
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Night version of outdoorScore. The scene model is trained on lit scenes, so at night the
 * main evidence is light: a sky is mostly dark, a lit room is bright and even. Darkness only
 * counts while the phone points up (a dark floor or a dark room seen level proves nothing),
 * and a frame that is almost black (lens covered, pocket) gives no verdict. When the frame is
 * bright enough for the model, its opinion is blended in. Phone auto-exposure brightens night
 * skies, so the luma bands are deliberately wide; tune them with field logs.
 */
export function nightOutdoorScore(
  light: { meanLuma: number; topLuma: number; darkFraction: number },
  pIndoor: number | null,
  elevationDeg: number | null,
): number | null {
  if (light.meanLuma < 6) return null;
  const lit = clamp((light.meanLuma - 75) / 35); // 40 -> -1 (dark), 110 -> +1 (lit room)
  const topLit = clamp((light.topLuma - 75) / 35);
  const dark = clamp((light.darkFraction - 0.35) * 3); // most of the frame dark -> outdoors
  const brightness = clamp(-0.4 * lit - 0.3 * topLit + 0.3 * dark);
  const pointingUp = elevationDeg !== null && elevationDeg >= 15;
  // Looking level or down, a dark frame is not evidence of open sky; brightness still says indoors.
  const lightScore = pointingUp ? brightness : Math.min(0, brightness);
  const model = pIndoor === null ? null : outdoorScore(pIndoor)!;
  if (model === null) return pointingUp || lightScore < 0 ? lightScore : null;
  return clamp(0.65 * lightScore + 0.35 * model);
}

export type CloudVisibility = { state: "visible"; reason: null } | { state: "hidden"; reason: "night" | "indoors" | "checking" };

const SMOOTH_MS = 2000;
const SWITCH_AFTER_MS = 4000;
const THRESHOLD = 0.15;

/**
 * Smooths the evidence and only switches indoor/outdoor after it has been consistent for
 * a few seconds. Starts unknown ("checking"); the first reading decides at once, later
 * changes need sustained evidence. Indoors always hides everything, day or night; outdoors
 * at night shows stand-in clouds. The caller picks the day or night score (outdoorScore /
 * nightOutdoorScore); the tracker treats both alike.
 */
export class VisibilityTracker {
  private daylight: boolean | null = null;
  private outdoors: boolean | null = null;
  private smoothed = 0;
  private pendingSince: number | null = null;
  private lastAt: number | null = null;

  get score() {
    return this.smoothed;
  }

  update(now: number, sunElevation: number, score: number | null): CloudVisibility {
    this.daylight = isDaylight(sunElevation, this.daylight);
    const dt = this.lastAt === null ? 0 : now - this.lastAt;
    this.lastAt = now;
    if (this.outdoors === null) {
      if (score !== null) {
        this.smoothed = score;
        this.outdoors = score > 0;
      }
    } else if (score !== null) this.smoothed += (score - this.smoothed) * (1 - Math.exp(-dt / SMOOTH_MS));
    if (this.outdoors === null) return { state: "hidden", reason: "checking" };
    const wantOutdoors = this.smoothed > THRESHOLD ? true : this.smoothed < -THRESHOLD ? false : this.outdoors;
    if (wantOutdoors === this.outdoors) this.pendingSince = null;
    else if (this.pendingSince === null) this.pendingSince = now;
    else if (now - this.pendingSince >= SWITCH_AFTER_MS) {
      this.outdoors = wantOutdoors;
      this.pendingSince = null;
    }
    if (!this.outdoors) return { state: "hidden", reason: "indoors" };
    if (!this.daylight) return { state: "hidden", reason: "night" };
    return { state: "visible", reason: null };
  }
}
