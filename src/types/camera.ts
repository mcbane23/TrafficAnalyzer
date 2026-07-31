/**
 * Shared domain types for the Belgrade camera registry.
 */

export type CameraProtocol = 'RTSP' | 'HTTP' | 'MJPEG' | 'HLS';

export type CameraStatus = 'active' | 'inactive';

export interface CameraLocation {
  address?: string;
  lat?: number;
  lon?: number;
}

/**
 * A single camera entry as stored in the registry JSON file
 * (see data/cameras/belgrade.schema.json for the full contract).
 */
export interface CameraEntry {
  id: string;
  name: string;
  location: CameraLocation;
  resolution?: string | null;
  source: string;
  url: string;
  protocol: CameraProtocol;
  status: CameraStatus;
  lastVerifiedAt: string | null;
  lastError?: string | null;
  /**
   * Extra HTTP request headers required to fetch `url` (e.g. a `Referer`
   * some providers require to defeat hotlink protection). When present,
   * the validator sends these headers when probing the stream, and the
   * web API exposes a same-origin proxy URL to the frontend instead of
   * `url` directly, since browsers won't let a page forge a third-party
   * Referer for its own requests.
   */
  headers?: Record<string, string>;
  /**
   * Optional backup stream URL covering the same location, used by the
   * frontend player as a fallback if `url` fails to load.
   */
  alternateUrl?: string;
  /**
   * Provider/publisher of `alternateUrl`, e.g. 'Informer.rs (Srbija na
   * dlanu network)'.
   */
  alternateSource?: string;
  /**
   * Extra HTTP request headers required to fetch `alternateUrl`,
   * mirroring `headers` for the primary url.
   */
  alternateHeaders?: Record<string, string>;
}

/**
 * The outcome of validating a single camera entry.
 */
export interface ValidationResult {
  cameraId: string;
  status: CameraStatus;
  checkedAt: string;
  resolution?: string;
  latencyMs?: number;
  error?: string;
}

export type RevalidationState = 'idle' | 'running';

/**
 * Progress/outcome of a background "check all cameras" run, as reported by
 * the server's revalidation endpoint and polled by the dashboard.
 */
export interface RevalidationStatus {
  state: RevalidationState;
  /** Total cameras in the current (or most recent) run. */
  total: number;
  /** Cameras checked so far in the current (or most recent) run. */
  checked: number;
  /** Cameras found active so far in the current (or most recent) run. */
  active: number;
  startedAt: string | null;
  finishedAt: string | null;
  error?: string | null;
}
