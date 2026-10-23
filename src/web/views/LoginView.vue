<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import { fetchAuthStatus, signIn } from '../services/auth';
import { t } from '../i18n';

const route = useRoute();
const router = useRouter();
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

/** Only an Admin page of this app, never another site. */
function nextPath(): string {
  const next = typeof route.query.next === 'string' ? route.query.next : '';
  return next.startsWith('/admin') ? next : '/admin';
}

onMounted(async () => {
  try {
    const status = await fetchAuthStatus();
    if (!status.required || status.signedIn) void router.replace(nextPath());
  } catch {
    // Leave the form up; signing in reports the problem.
  }
});

async function submit() {
  if (busy.value || !password.value) return;
  busy.value = true;
  error.value = null;
  const result = await signIn(password.value);
  busy.value = false;
  if (result === 'ok') {
    void router.replace(nextPath());
    return;
  }
  password.value = '';
  error.value = t(result === 'wrong' ? 'login.wrong' : result === 'blocked' ? 'login.blocked' : 'login.error');
}
</script>

<template>
  <main class="mx-auto flex max-w-sm flex-col px-4 py-16">
    <form class="rounded-xl border border-slate-800 bg-slate-900 p-6" @submit.prevent="submit">
      <div class="flex items-center gap-2 text-slate-100">
        <AppIcon name="lock" class="h-5 w-5 text-sky-400" />
        <h1 class="text-lg font-semibold">{{ t('login.title') }}</h1>
      </div>
      <p class="mt-1 text-sm text-slate-400">{{ t('login.subtitle') }}</p>
      <label class="mt-5 block text-xs text-slate-400" for="admin-password">{{ t('login.password') }}</label>
      <input
        id="admin-password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        autofocus
        class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-sky-500 focus:outline-none"
      />
      <p v-if="error" class="mt-3 text-sm text-red-300" role="alert">{{ error }}</p>
      <button
        type="submit"
        :disabled="busy || !password"
        class="mt-5 w-full rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {{ busy ? t('login.busy') : t('login.submit') }}
      </button>
    </form>
  </main>
</template>
