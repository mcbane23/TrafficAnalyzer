import { ref } from 'vue';

/**
 * What the current page is about when the route alone doesn't say (the
 * camera's name on its page), for the browser tab title App.vue builds.
 */
export const pageSubject = ref<string | null>(null);
