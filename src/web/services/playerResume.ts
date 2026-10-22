/**
 * What the player does when its browser tab comes back to the foreground.
 *
 * A hidden tab is not left alone by the browser: its timers are throttled
 * (after a few minutes to about once a minute, which starves hls.js and lets
 * the video stall), a muted video may be paused, and the page may be frozen
 * outright, holding back or dropping the overlay stream's events. On return
 * the picture then sits far behind the live edge, or the overlay results for
 * it never arrived, and the viewer saw no boxes for about half a minute
 * while the player crawled back (Bane, 2026-10-22).
 *
 * So after a long enough absence the player jumps back to its usual place
 * behind the live edge, resumes a paused video, and re-subscribes to the
 * overlay, which replays the server's recent results for that picture.
 */
export interface ResumeState {
  /** How long the tab was hidden. */
  hiddenForMs: number;
  paused: boolean;
  /** The video's playhead (media seconds). */
  currentTime: number;
  /** hls.js' target playhead behind the live edge, or null without hls.js / before it knows. */
  liveSyncPosition: number | null;
  /** The stream's segment length (s), or null before the playlist is loaded. */
  targetDuration: number | null;
}

export interface ResumePlan {
  /** Where to move the playhead, or null to leave it. */
  seekTo: number | null;
  play: boolean;
  /** Re-open the overlay stream so the server replays its recent results. */
  refreshOverlay: boolean;
}

/** Shorter absences (a quick alt-tab) leave the player as it is. */
export const RESUME_AFTER_HIDDEN_MS = 5_000;

/** How far behind its usual place the playhead may be before it is moved, when the segment length isn't known yet. */
const DEFAULT_TOLERANCE_SECONDS = 10;

export function planResume(state: ResumeState): ResumePlan {
  if (state.hiddenForMs < RESUME_AFTER_HIDDEN_MS) return { seekTo: null, play: false, refreshOverlay: false };
  const tolerance = state.targetDuration ?? DEFAULT_TOLERANCE_SECONDS;
  const behind = state.liveSyncPosition !== null && state.currentTime < state.liveSyncPosition - tolerance;
  return {
    seekTo: behind ? state.liveSyncPosition : null,
    play: state.paused,
    refreshOverlay: true,
  };
}
