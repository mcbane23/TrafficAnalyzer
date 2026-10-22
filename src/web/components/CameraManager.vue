<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { CameraEntry } from '../../types/camera';
import type { RoadAxis } from '../../types/stats';
import { addCamera, deleteCamera, fetchAdminCameras, updateCamera } from '../services/admin';
import { cameraSnapshotUrl, fetchCameraStats } from '../services/stats';
import { t } from '../i18n';
import AppIcon from './AppIcon.vue';
import ZoneEditor from './ZoneEditor.vue';

/**
 * The Admin page's camera list: rename a camera, name its two directions,
 * draw the parts of its view the analysis should ignore, hide it from the
 * dashboard and statistics (it is then never analyzed), delete it, or add a
 * new one.
 * Every change is saved to the registry in the data volume and applied
 * without a restart.
 */
const emit = defineEmits<{ changed: [] }>();

type Zone = { name?: string; points: Array<[number, number]> };

const cameras = ref<CameraEntry[] | null>(null);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null);
const showHidden = ref(false);

const hiddenCount = computed(() => cameras.value?.filter((camera) => camera.hidden).length ?? 0);
const listed = computed(() => (cameras.value ?? []).filter((camera) => showHidden.value || !camera.hidden));

async function load() {
  try {
    cameras.value = await fetchAdminCameras();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('cameraEdit.loadFailed');
  }
}

function replace(camera: CameraEntry) {
  if (!cameras.value) return;
  const index = cameras.value.findIndex((c) => c.id === camera.id);
  if (index === -1) cameras.value = [...cameras.value, camera];
  else cameras.value = cameras.value.map((c, i) => (i === index ? camera : c));
}

async function setHidden(camera: CameraEntry, hidden: boolean) {
  busyId.value = camera.id;
  try {
    replace(await updateCamera(camera.id, { hidden }));
    error.value = null;
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('cameraEdit.saveFailed');
  } finally {
    busyId.value = null;
  }
}

async function remove(camera: CameraEntry) {
  if (!window.confirm(t('cameraEdit.deleteConfirm', { name: camera.name }))) return;
  busyId.value = camera.id;
  try {
    await deleteCamera(camera.id);
    cameras.value = (cameras.value ?? []).filter((c) => c.id !== camera.id);
    error.value = null;
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('cameraEdit.saveFailed');
  } finally {
    busyId.value = null;
  }
}

// --- Edit dialog ---------------------------------------------------------

const editing = ref<CameraEntry | null>(null);
const form = reactive({ name: '', address: '', a: '', b: '', zones: [] as Zone[] });
const axis = ref<RoadAxis | null>(null);
const snapshotUrl = ref('');
const saving = ref(false);
const editError = ref<string | null>(null);

function openEditor(camera: CameraEntry) {
  editing.value = camera;
  form.name = camera.name;
  form.address = camera.location.address ?? '';
  form.a = camera.directions?.a ?? '';
  form.b = camera.directions?.b ?? '';
  form.zones = JSON.parse(JSON.stringify(camera.ignoreZones ?? [])) as Zone[];
  editError.value = null;
  snapshotUrl.value = cameraSnapshotUrl(camera.id, Date.now());
  axis.value = null;
  // The road axis the statistics learned, to show which way A and B run; a camera never analyzed has none.
  fetchCameraStats(camera.id, '7d')
    .then((stats) => {
      if (editing.value?.id === camera.id) axis.value = stats.axis;
    })
    .catch(() => undefined);
}

function closeEditor() {
  if (!saving.value) editing.value = null;
}

async function saveEditor() {
  const camera = editing.value;
  if (!camera || saving.value) return;
  if (!form.name.trim()) {
    editError.value = t('cameraEdit.error.no-name');
    return;
  }
  saving.value = true;
  try {
    const updated = await updateCamera(camera.id, {
      name: form.name,
      ...(form.address.trim() ? { address: form.address } : {}),
      directions: form.a.trim() || form.b.trim() ? { a: form.a, b: form.b } : null,
      ignoreZones: form.zones,
    });
    replace(updated);
    editing.value = null;
    emit('changed');
  } catch (err) {
    editError.value = err instanceof Error ? err.message : t('cameraEdit.saveFailed');
  } finally {
    saving.value = false;
  }
}

// --- Add form ------------------------------------------------------------

const adding = ref(false);
const newCamera = reactive({ name: '', address: '', url: '', referer: '' });
const addBusy = ref(false);
const addError = ref<string | null>(null);
const added = ref<CameraEntry | null>(null);

function openAdd() {
  adding.value = true;
  added.value = null;
  addError.value = null;
}

async function submitAdd() {
  if (addBusy.value) return;
  addBusy.value = true;
  addError.value = null;
  try {
    const camera = await addCamera({
      name: newCamera.name,
      address: newCamera.address,
      url: newCamera.url,
      ...(newCamera.referer.trim() ? { referer: newCamera.referer } : {}),
    });
    replace(camera);
    added.value = camera;
    Object.assign(newCamera, { name: '', address: '', url: '', referer: '' });
    adding.value = false;
    emit('changed');
  } catch (err) {
    addError.value = err instanceof Error ? err.message : t('cameraEdit.saveFailed');
  } finally {
    addBusy.value = false;
  }
}

const inputClass = 'mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none';

onMounted(load);
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-semibold text-slate-100">{{ t('cameraEdit.title') }}</h2>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <label v-if="hiddenCount > 0" class="flex cursor-pointer items-center gap-1.5 text-slate-400">
          <input v-model="showHidden" type="checkbox" class="accent-sky-500" />
          {{ t('cameraEdit.showHidden', { count: hiddenCount }) }}
        </label>
        <button type="button" class="rounded-md bg-sky-600 px-2.5 py-1 font-medium text-white hover:bg-sky-500" @click="openAdd">
          + {{ t('cameraEdit.add') }}
        </button>
      </div>
    </div>
    <p class="mt-1 max-w-3xl text-xs text-slate-400">{{ t('cameraEdit.note') }}</p>

    <p v-if="error" class="mt-3 text-xs text-red-400">{{ error }}</p>
    <p v-if="!cameras && !error" class="mt-3 text-sm text-slate-500">{{ t('cameraEdit.loading') }}</p>
    <p v-if="added" class="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
      {{ added.status === 'active' ? t('cameraEdit.addedActive', { name: added.name }) : t('cameraEdit.addedInactive', { name: added.name, error: added.lastError ?? '' }) }}
    </p>

    <!-- Add form -->
    <form v-if="adding" class="mt-4 rounded-lg border border-slate-700 bg-slate-950/60 p-3" @submit.prevent="submitAdd">
      <h3 class="text-sm font-semibold text-slate-100">{{ t('cameraEdit.addTitle') }}</h3>
      <div class="mt-2 grid gap-3 sm:grid-cols-2">
        <label class="block text-xs text-slate-500">{{ t('cameraEdit.name') }}
          <input v-model="newCamera.name" :class="inputClass" required maxlength="120" :placeholder="t('cameraEdit.namePlaceholder')" />
        </label>
        <label class="block text-xs text-slate-500">{{ t('cameraEdit.address') }}
          <input v-model="newCamera.address" :class="inputClass" required maxlength="200" :placeholder="t('cameraEdit.addressPlaceholder')" />
        </label>
        <label class="block text-xs text-slate-500 sm:col-span-2">{{ t('cameraEdit.url') }}
          <input v-model="newCamera.url" :class="inputClass" required type="url" placeholder="https://…/index.m3u8" />
          <span class="mt-1 block text-[11px]">{{ t('cameraEdit.urlNote') }}</span>
        </label>
        <label class="block text-xs text-slate-500 sm:col-span-2">{{ t('cameraEdit.referer') }}
          <input v-model="newCamera.referer" :class="inputClass" placeholder="https://…" />
          <span class="mt-1 block text-[11px]">{{ t('cameraEdit.refererNote') }}</span>
        </label>
      </div>
      <p v-if="addError" class="mt-2 text-xs text-red-400">{{ addError }}</p>
      <div class="mt-3 flex items-center gap-2">
        <button type="submit" class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60" :disabled="addBusy">
          {{ addBusy ? t('cameraEdit.probing') : t('cameraEdit.addSubmit') }}
        </button>
        <button type="button" class="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800" :disabled="addBusy" @click="adding = false">
          {{ t('cameraEdit.cancel') }}
        </button>
      </div>
    </form>

    <!-- Camera list -->
    <ul v-if="cameras" class="mt-3 divide-y divide-slate-800">
      <li v-for="camera in listed" :key="camera.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" :class="camera.hidden ? 'opacity-60' : ''">
        <span class="h-2 w-2 shrink-0 rounded-full" :class="camera.status === 'active' ? 'bg-emerald-400' : 'bg-slate-600'" :title="camera.status === 'active' ? t('cameraEdit.online') : t('cameraEdit.offline')"></span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-slate-200">
            {{ camera.name }}
            <span v-if="camera.hidden" class="ml-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{{ t('cameraEdit.hiddenBadge') }}</span>
          </div>
          <div class="truncate text-xs text-slate-500">
            {{ camera.location.address }}
            <template v-if="camera.directions?.a || camera.directions?.b"> · A: {{ camera.directions?.a || '–' }}, B: {{ camera.directions?.b || '–' }}</template>
            <template v-if="camera.ignoreZones?.length"> · {{ t('cameraEdit.zoneCount', { count: camera.ignoreZones.length }) }}</template>
          </div>
        </div>
        <button type="button" class="rounded-md px-2 py-1 text-xs text-sky-400 hover:bg-slate-800 hover:text-sky-300" @click="openEditor(camera)">
          {{ t('cameraEdit.edit') }}
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
          :disabled="busyId === camera.id"
          @click="setHidden(camera, !camera.hidden)"
        >
          {{ camera.hidden ? t('cameraEdit.show') : t('cameraEdit.hide') }}
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-xs text-red-400 hover:bg-slate-800 hover:text-red-300 disabled:opacity-50"
          :disabled="busyId === camera.id"
          @click="remove(camera)"
        >
          {{ t('cameraEdit.delete') }}
        </button>
      </li>
    </ul>

    <!-- Edit dialog -->
    <div v-if="editing" class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/80 p-4" @click.self="closeEditor" @keydown.esc="closeEditor">
      <form class="my-4 w-full max-w-4xl rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl" @submit.prevent="saveEditor">
        <div class="flex items-start justify-between gap-3">
          <h3 class="font-semibold text-slate-100">{{ t('cameraEdit.editTitle', { name: editing.name }) }}</h3>
          <button type="button" class="text-slate-400 hover:text-slate-200" :aria-label="t('cameraEdit.cancel')" @click="closeEditor"><AppIcon name="close" /></button>
        </div>

        <div class="mt-3 grid gap-4 lg:grid-cols-[1fr_18rem]">
          <div>
            <h4 class="text-sm font-medium text-slate-200">{{ t('zones.title') }}</h4>
            <p class="mb-2 text-xs text-slate-400">{{ t('zones.note') }}</p>
            <ZoneEditor
              v-model="form.zones"
              :image-url="snapshotUrl"
              :axis="axis"
              :label-a="form.a.trim() || t('direction.a')"
              :label-b="form.b.trim() || t('direction.b')"
            />
          </div>

          <div class="space-y-3">
            <label class="block text-xs text-slate-500">{{ t('cameraEdit.name') }}
              <input v-model="form.name" :class="inputClass" required maxlength="120" />
            </label>
            <label class="block text-xs text-slate-500">{{ t('cameraEdit.address') }}
              <input v-model="form.address" :class="inputClass" maxlength="200" />
            </label>
            <div>
              <span class="text-xs text-slate-500">{{ t('cameraEdit.directions') }}</span>
              <label class="mt-1 flex items-center gap-2 text-xs text-slate-400">
                <span class="w-4 font-semibold text-sky-300">A</span>
                <input v-model="form.a" :class="inputClass" class="!mt-0" maxlength="60" :placeholder="t('cameraEdit.directionPlaceholder')" />
              </label>
              <label class="mt-1 flex items-center gap-2 text-xs text-slate-400">
                <span class="w-4 font-semibold text-sky-300">B</span>
                <input v-model="form.b" :class="inputClass" class="!mt-0" maxlength="60" :placeholder="t('cameraEdit.directionPlaceholder')" />
              </label>
              <p class="mt-1 text-[11px] text-slate-500">{{ axis ? t('cameraEdit.directionsNote') : t('cameraEdit.directionsNoAxis') }}</p>
            </div>
            <p class="text-[11px] text-slate-500">{{ t('cameraEdit.zonesApply') }}</p>
          </div>
        </div>

        <p v-if="editError" class="mt-3 text-xs text-red-400">{{ editError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800" :disabled="saving" @click="closeEditor">
            {{ t('cameraEdit.cancel') }}
          </button>
          <button type="submit" class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60" :disabled="saving">
            {{ saving ? t('cameraEdit.saving') : t('cameraEdit.save') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>
