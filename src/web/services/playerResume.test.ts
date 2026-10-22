import { planResume, RESUME_AFTER_HIDDEN_MS } from './playerResume';

describe('planResume', () => {
  const longAway = { hiddenForMs: 5 * 60_000, paused: false, currentTime: 1000, liveSyncPosition: 1000, targetDuration: 10 };

  it('leaves the player alone after a quick alt-tab', () => {
    expect(planResume({ ...longAway, hiddenForMs: RESUME_AFTER_HIDDEN_MS - 1, currentTime: 100, paused: true })).toEqual({
      seekTo: null,
      play: false,
      refreshOverlay: false,
    });
  });

  it('jumps a stalled picture back to its place behind the live edge', () => {
    expect(planResume({ ...longAway, currentTime: 700 }).seekTo).toBe(1000);
  });

  it('does not seek a picture that is already about where it belongs', () => {
    expect(planResume({ ...longAway, currentTime: 992 }).seekTo).toBeNull();
    expect(planResume({ ...longAway, currentTime: 1003 }).seekTo).toBeNull();
  });

  it('does not seek without a live position (native player, playlist not loaded)', () => {
    expect(planResume({ ...longAway, currentTime: 10, liveSyncPosition: null }).seekTo).toBeNull();
  });

  it('uses one segment as the tolerance, or 10 s before the playlist is known', () => {
    expect(planResume({ ...longAway, targetDuration: 2, currentTime: 997 }).seekTo).toBe(1000);
    expect(planResume({ ...longAway, targetDuration: null, currentTime: 995 }).seekTo).toBeNull();
    expect(planResume({ ...longAway, targetDuration: null, currentTime: 985 }).seekTo).toBe(1000);
  });

  it('resumes a video the browser paused and refreshes the overlay after a long absence', () => {
    expect(planResume({ ...longAway, paused: true })).toEqual({ seekTo: null, play: true, refreshOverlay: true });
  });
});
