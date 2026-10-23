import { ref, watchEffect } from 'vue';

/**
 * Dark, light, or whatever the system uses. Kept per browser. The choice is
 * applied as `data-theme` on <html>, which flips the palette in style.css;
 * index.html applies it once before the app loads so the page never flashes.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

function load(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Storage unavailable - follow the system.
  }
  return 'system';
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
const systemLight = ref(media?.matches ?? false);
media?.addEventListener('change', (event) => (systemLight.value = event.matches));

export const themeChoice = ref<ThemeChoice>(load());
/** The theme in effect: the choice, or the system's when the choice is 'system'. */
export const theme = ref<'light' | 'dark'>('dark');

watchEffect(() => {
  theme.value = themeChoice.value === 'system' ? (systemLight.value ? 'light' : 'dark') : themeChoice.value;
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.value === 'light' ? '#f1f5f9' : '#020617');
});

/** Steps through system, light and dark (the header's single button). */
export function cycleTheme(): void {
  themeChoice.value = ORDER[(ORDER.indexOf(themeChoice.value) + 1) % ORDER.length];
  try {
    localStorage.setItem(STORAGE_KEY, themeChoice.value);
  } catch {
    // Storage unavailable - the choice lasts until the page is left.
  }
}
