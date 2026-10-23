import { ref } from 'vue';

/**
 * Cameras starred on the dashboard, shown before the rest. Kept per browser
 * (like the layout and sort), so each person who opens the app has their own.
 */
const STORAGE_KEY = 'favorite-cameras';

function load(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export const favoriteIds = ref<Set<string>>(load());

export function isFavorite(cameraId: string): boolean {
  return favoriteIds.value.has(cameraId);
}

export function toggleFavorite(cameraId: string): void {
  const next = new Set(favoriteIds.value);
  if (!next.delete(cameraId)) next.add(cameraId);
  favoriteIds.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Storage unavailable - the star lasts until the page is reloaded.
  }
}
