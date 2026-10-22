<script setup lang="ts">
import { computed, ref } from 'vue';
import { authStatus, changePassword } from '../services/auth';
import { t } from '../i18n';

const MIN_LENGTH = 6;

const current = ref('');
const password = ref('');
const repeat = ref('');
const busy = ref(false);
const message = ref<{ ok: boolean; text: string } | null>(null);

const source = computed(() => authStatus.value?.source ?? null);
const hasPassword = computed(() => source.value === 'admin');
const mismatch = computed(() => repeat.value !== '' && repeat.value !== password.value);
const canSave = computed(
  () => !busy.value && password.value.length >= MIN_LENGTH && password.value === repeat.value && (!hasPassword.value || current.value !== ''),
);

async function run(next: string, okText: string) {
  busy.value = true;
  message.value = null;
  const result = await changePassword(current.value, next);
  busy.value = false;
  if (result === 'ok') {
    current.value = password.value = repeat.value = '';
    message.value = { ok: true, text: okText };
    return;
  }
  const errors = { wrong: 'password.wrong', short: 'password.short', env: 'password.envSet', error: 'password.error' } as const;
  message.value = { ok: false, text: t(errors[result]) };
}

function save() {
  if (canSave.value) void run(password.value, t(hasPassword.value ? 'password.changed' : 'password.set'));
}

function remove() {
  if (!busy.value && current.value && window.confirm(t('password.removeConfirm'))) void run('', t('password.removed'));
}
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <h2 class="font-semibold text-slate-100">{{ t('password.title') }}</h2>
    <p v-if="source === 'env'" class="mt-1 text-sm text-slate-400">{{ t('password.envNote') }}</p>
    <template v-else>
      <p class="mt-1 text-xs text-slate-400">{{ t(hasPassword ? 'password.noteSet' : 'password.noteNone') }}</p>
      <form class="mt-3 grid gap-3 sm:grid-cols-3" @submit.prevent="save">
        <label v-if="hasPassword" class="block text-xs text-slate-400">
          {{ t('password.current') }}
          <input v-model="current" type="password" autocomplete="current-password" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none" />
        </label>
        <label class="block text-xs text-slate-400">
          {{ t('password.new', { min: MIN_LENGTH }) }}
          <input v-model="password" type="password" autocomplete="new-password" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none" />
        </label>
        <label class="block text-xs text-slate-400">
          {{ t('password.repeat') }}
          <input v-model="repeat" type="password" autocomplete="new-password" class="mt-1 w-full rounded-lg border bg-slate-950 px-3 py-1.5 text-sm text-slate-100 focus:outline-none" :class="mismatch ? 'border-red-500' : 'border-slate-700 focus:border-sky-500'" />
        </label>
        <div class="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button type="submit" :disabled="!canSave" class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            {{ t(hasPassword ? 'password.change' : 'password.setButton') }}
          </button>
          <button v-if="hasPassword" type="button" :disabled="busy || !current" class="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-red-500 hover:text-red-300 disabled:opacity-50" @click="remove">
            {{ t('password.remove') }}
          </button>
          <span v-if="mismatch" class="text-xs text-red-300">{{ t('password.mismatch') }}</span>
          <span v-if="message" class="text-xs" :class="message.ok ? 'text-emerald-300' : 'text-red-300'" role="status">{{ message.text }}</span>
        </div>
      </form>
    </template>
  </section>
</template>
