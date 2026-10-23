/** How many cameras the video wall can show: the camera server speaks HTTP/1.1, so a browser opens at most 6 connections to it. */
export const WALL_SLOTS = 4;

interface WallCamera {
  id: string;
  status: string;
}

/**
 * The cameras for the wall's slots: the saved choice where those cameras
 * still exist (an empty slot stays empty), otherwise favorites first and
 * then the other working cameras, in list order.
 */
export function wallCameras(saved: Array<string | null> | null, cameras: WallCamera[], favorites: Set<string>): Array<string | null> {
  const known = new Set(cameras.map((c) => c.id));
  if (saved && saved.length > 0) {
    const slots = saved.slice(0, WALL_SLOTS).map((id) => (id && known.has(id) ? id : null));
    while (slots.length < WALL_SLOTS) slots.push(null);
    return slots;
  }
  const active = cameras.filter((c) => c.status === 'active');
  const ordered = [...active.filter((c) => favorites.has(c.id)), ...active.filter((c) => !favorites.has(c.id))];
  const slots: Array<string | null> = ordered.slice(0, WALL_SLOTS).map((c) => c.id);
  while (slots.length < WALL_SLOTS) slots.push(null);
  return slots;
}
