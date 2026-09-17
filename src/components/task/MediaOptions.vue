<script setup lang="ts">
/** @fileoverview Contextual controls for a natively inspected media presentation. */
import { computed, watch, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NFormItem, NSelect, NInputNumber } from 'naive-ui'
import type { Aria2MediaTrack } from '@shared/types'
import { mediaTrackLabel, type MediaOptions } from '@shared/utils/media'

const model = defineModel<MediaOptions>({ required: true })
const props = defineProps<{ tracks: Aria2MediaTrack[]; live: boolean; disabled?: boolean }>()
const { t, locale } = useI18n()
const hasVideo = computed(() => props.tracks.some((track) => ['video', 'muxed'].includes(track.type)))
const hasAudio = computed(() => props.tracks.some((track) => ['audio', 'muxed'].includes(track.type)))
const hasSubtitles = computed(() => props.tracks.some((track) => track.type === 'subtitle'))
const content = computed({
  get: () => (model.value.video === 'none' ? 'audio' : model.value.audio === 'none' ? 'video' : 'both'),
  set: (value: string) => {
    model.value.video = value === 'audio' ? 'none' : 'best'
    model.value.audio = value === 'video' ? 'none' : 'best'
  },
})
const contentOptions = computed(() => [
  { value: 'both', label: t('media.video-audio') },
  { value: 'audio', label: t('media.audio-only') },
  { value: 'video', label: t('media.video-only') },
])
const selectedVideo = computed(() =>
  model.value.video === 'none'
    ? undefined
    : (props.tracks.find((track) => track.id === model.value.video) ??
      props.tracks.find((track) => track.selected === 'true' && ['video', 'muxed'].includes(track.type))),
)
watch(selectedVideo, (video) => {
  if (model.value.audio === 'none' || model.value.audio === 'best') return
  const audio = props.tracks.find((track) => track.id === model.value.audio)
  if ((video?.type === 'muxed' && audio?.id !== video.id) || (video?.type === 'video' && audio?.type === 'muxed'))
    model.value.audio = 'best'
})
function choices(type: 'video' | 'audio' | 'subtitle') {
  return [
    ...(type === 'subtitle' ? [{ value: 'none', label: t('media.none') }] : []),
    { value: 'best', label: t('media.best') },
    ...props.tracks
      .filter((track) => {
        if (type === 'audio' && selectedVideo.value?.type === 'muxed') return track.id === selectedVideo.value.id
        return (
          track.type === type ||
          (track.type === 'muxed' && (type === 'video' || (type === 'audio' && model.value.video === 'none')))
        )
      })
      .map((track) => ({ value: track.id, label: mediaTrackLabel(track, locale.value) })),
  ]
}
watch(
  () => props.tracks,
  () => {
    if (!hasVideo.value) model.value.video = 'none'
    if (!hasAudio.value) model.value.audio = 'none'
    if (!hasSubtitles.value) model.value.subtitles = 'none'
  },
  { immediate: true },
)
const durationPresets = [0, 900, 1800, 3600]
const customDuration = ref(!durationPresets.includes(model.value.recordTime))
const durationPreset = computed({
  get: () => (customDuration.value ? -1 : model.value.recordTime),
  set: (value: number) => {
    customDuration.value = value === -1
    model.value.recordTime = value === -1 ? model.value.recordTime || 60 : value
  },
})
const durationOptions = computed(() => [
  { value: 0, label: t('media.unlimited') },
  ...durationPresets
    .filter((seconds) => seconds > 0)
    .map((seconds) => ({
      value: seconds,
      label: new Intl.NumberFormat(locale.value, {
        style: 'unit',
        unit: seconds >= 3600 ? 'hour' : 'minute',
        unitDisplay: 'short',
      }).format(seconds >= 3600 ? seconds / 3600 : seconds / 60),
    })),
  { value: -1, label: t('media.custom') },
])
</script>

<template>
  <TransitionGroup name="media-field" tag="div" class="media-fields">
    <NFormItem
      v-if="hasVideo && hasAudio"
      key="content"
      class="media-field-wide"
      :label="t('media.content')"
      :show-feedback="false"
    >
      <NSelect v-model:value="content" :options="contentOptions" :disabled="disabled" />
    </NFormItem>
    <NFormItem v-if="hasVideo && model.video !== 'none'" key="video" :label="t('media.video')" :show-feedback="false">
      <NSelect v-model:value="model.video" :options="choices('video')" :disabled="disabled" />
    </NFormItem>
    <NFormItem v-if="hasAudio && model.audio !== 'none'" key="audio" :label="t('media.audio')" :show-feedback="false">
      <NSelect v-model:value="model.audio" :options="choices('audio')" filterable :disabled="disabled" />
    </NFormItem>
    <NFormItem v-if="hasSubtitles" key="subtitles" :label="t('media.subtitles')" :show-feedback="false">
      <NSelect v-model:value="model.subtitles" :options="choices('subtitle')" filterable :disabled="disabled" />
    </NFormItem>
    <NFormItem key="format" :label="t('media.format')" :show-feedback="false">
      <NSelect
        v-model:value="model.format"
        :options="[
          { value: 'mp4', label: 'MP4' },
          { value: 'mkv', label: 'MKV' },
        ]"
        :disabled="disabled"
      />
    </NFormItem>
    <NFormItem
      v-if="live"
      key="duration"
      class="media-field-wide"
      :label="t('media.record-time')"
      :show-feedback="false"
    >
      <div class="media-duration">
        <NSelect v-model:value="durationPreset" :options="durationOptions" :disabled="disabled" />
        <NInputNumber
          v-if="customDuration"
          v-model:value="model.recordTime"
          :min="1"
          :max="31536000"
          :precision="0"
          :disabled="disabled"
        >
          <template #suffix>{{ t('app.second') }}</template>
        </NInputNumber>
      </div>
    </NFormItem>
  </TransitionGroup>
</template>

<style scoped>
.media-fields {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.media-field-wide {
  grid-column: 1 / -1;
}
.media-duration {
  display: flex;
  gap: 12px;
  width: 100%;
}
.media-duration > * {
  flex: 1;
  min-width: 0;
}
.media-field-enter-active,
.media-field-move {
  transition:
    opacity var(--task-motion-enter) var(--task-motion-ease),
    transform var(--task-motion-enter) var(--task-motion-ease);
}
.media-field-leave-active {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.media-field-enter-from {
  opacity: 0;
}
@media (max-width: 420px) {
  .media-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
