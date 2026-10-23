<script setup lang="ts">
import { ref } from 'vue';
import { restoreBackup } from '../services/admin';
import { formatNumber, t } from '../i18n';

const emit = defineEmits<{ restored: [] }>();

const input = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const message = ref<{ ok: boolean; text: string } | null>(null);

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (input.value) input.value.value = '';
  if (!file || busy.value) return;
  if (!window.confirm(t('backup.confirm', { name: file.name }))) return;
  busy.value = true;
  message.value = null;
  try {
    const summary = await restoreBackup(file);
    message.value = { ok: true, text: t('backup.restored', { passages: formatNumber(summary.passages), cameras: summary.cameras }) };
    emit('restored');
  } catch (err) {
    message.value = { ok: false, text: err instanceof Error ? err.message : t('backup.failed') };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <h2 class="font-semibold text-slate-100">{{ t('backup.title') }}</h2>
    <p class="mt-1 max-w-3xl text-xs text-slate-400">{{ t('backup.note') }}</p>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <a href="/api/admin/backup" download class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500">
        {{ t('backup.download') }}
      </a>
      <label
        class="cursor-pointer rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500 hover:text-slate-100 focus-within:ring-2 focus-within:ring-sky-500"
        :class="{ 'pointer-events-none opacity-50': busy }"
      >
        {{ busy ? t('backup.restoring') : t('backup.restore') }}
        <input ref="input" type="file" accept=".sqlite,.db,application/octet-stream" class="sr-only" :disabled="busy" @change="onFile" />
      </label>
      <span v-if="message" class="text-xs" :class="message.ok ? 'text-emerald-300' : 'text-red-300'" role="status">{{ message.text }}</span>
    </div>
  </section>
</template>
