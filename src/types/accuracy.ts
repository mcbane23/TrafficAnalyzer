import { PassageDirection, RoadAxis, SizeClass } from './stats';

/**
 * A counting-accuracy check: the server records a few minutes of one
 * camera, runs the same motion analysis on the clip as it runs live, and
 * the user counts the vehicles on the same clip by hand. Times are seconds
 * from the start of the clip.
 */
export type AccuracyCheckState = 'recording' | 'analyzing' | 'ready' | 'failed';

/** One vehicle the analysis counted on the clip. */
export interface CheckPassage {
  /** Midway between when the vehicle was first and last seen, in clip seconds. */
  t: number;
  direction: PassageDirection | null;
  sizeClass: SizeClass;
}

/** One vehicle the user counted, by clicking while the clip played. */
export interface ManualCount {
  t: number;
  direction: PassageDirection | null;
}

export interface AccuracyCheck {
  id: string;
  cameraId: string;
  cameraName: string;
  /** Direction names from the registry, if set. */
  directions?: { a?: string; b?: string };
  createdAt: string;
  state: AccuracyCheckState;
  /** 0..1 within the current state (recording, then analyzing). */
  progress: number;
  error?: string;
  /** Seconds compared (the clip is `warmupSec` longer). */
  durationSec: number;
  /** Seconds at the start of the clip the analysis needs to learn the background; not compared. */
  warmupSec: number;
  analysisFps: number | null;
  /** The compared stretch of the clip: [countFrom, countTo) seconds. */
  countFrom: number;
  countTo: number;
  /** The road axis direction A points along, as the statistics have learned it. */
  axis: RoadAxis | null;
  passages: CheckPassage[];
  manual: ManualCount[] | null;
  manualSavedAt: string | null;
  /** Whether the recorded clip is still kept (older ones are deleted to save space). */
  hasClip: boolean;
}

export interface DirectionCounts {
  total: number;
  a: number;
  b: number;
}

export interface AccuracyCheckSummary {
  id: string;
  cameraId: string;
  cameraName: string;
  createdAt: string;
  state: AccuracyCheckState;
  durationSec: number;
  app: DirectionCounts | null;
  manual: DirectionCounts | null;
}

export interface AccuracyChecksResponse {
  checks: AccuracyCheckSummary[];
  /** Seconds a new check records by default, and the choices offered. */
  durations: number[];
}

/** Counts by direction of the events inside [from, to). */
export function countEvents(events: Array<{ t: number; direction: PassageDirection | null }>, from: number, to: number): DirectionCounts {
  const counts: DirectionCounts = { total: 0, a: 0, b: 0 };
  for (const event of events) {
    if (event.t < from || event.t >= to) continue;
    counts.total += 1;
    if (event.direction === 'A') counts.a += 1;
    else if (event.direction === 'B') counts.b += 1;
  }
  return counts;
}

/** How far the app's count is from the user's, as a signed share of the user's (+0.1 = the app counted 10% more). */
export function countError(app: number, manual: number): number | null {
  return manual > 0 ? (app - manual) / manual : null;
}
