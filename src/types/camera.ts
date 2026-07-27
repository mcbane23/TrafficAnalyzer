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
