import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { Aria2MediaTrack } from '@shared/types'
import { defaultMediaOptions } from '@shared/utils/media'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en-US') }) }))
import MediaOptions from '../MediaOptions.vue'

const muxed: Aria2MediaTrack = {
  id: 'muxed-main',
  type: 'muxed',
  language: 'en',
  codec: 'avc1,mp4a',
  width: '1280',
  height: '720',
  bandwidth: '1000000',
  selected: 'true',
}
function setup(tracks: Aria2MediaTrack[], live = false) {
  const model = ref(defaultMediaOptions())
  const wrapper = mount(MediaOptions, {
    props: { tracks, live, modelValue: model.value },
    global: {
      stubs: {
        FormItem: { props: ['label'], template: '<div :data-label="label"><slot /></div>' },
        Select: { name: 'Select', props: ['value', 'options'], emits: ['update:value'], template: '<input />' },
        CollapseTransition: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
        InputNumber: true,
      },
    },
  })
  return { wrapper, model }
}

describe('contextual media controls', () => {
  it('hides unavailable subtitles and recording duration for on-demand media', () => {
    const { wrapper } = setup([muxed])
    expect(wrapper.find('[data-label="media.subtitles"]').exists()).toBe(false)
    expect(wrapper.find('[data-label="media.record-time"]').exists()).toBe(false)
    expect(wrapper.find('[data-label="media.video"]').exists()).toBe(true)
    const video = wrapper.find('[data-label="media.video"]').findComponent({ name: 'Select' })
    expect(video.props('options')).toContainEqual({
      value: 'muxed-main',
      label: 'English · 1280×720 · avc1,mp4a · 1000 kb/s',
    })
    wrapper.unmount()
  })
  it('switches multiplexed media to audio-only without contradictory video selection', async () => {
    const { wrapper, model } = setup([muxed], true)
    wrapper.find('[data-label="media.content"]').findComponent({ name: 'Select' }).vm.$emit('update:value', 'audio')
    await wrapper.vm.$nextTick()
    expect(model.value.video).toBe('none')
    expect(model.value.audio).toBe('best')
    expect(wrapper.find('[data-label="media.video"]').exists()).toBe(false)
    expect(wrapper.find('[data-label="media.record-time"]').exists()).toBe(true)
    expect(
      wrapper.find('[data-label="media.audio"]').findComponent({ name: 'Select' }).props('options'),
    ).toContainEqual(expect.objectContaining({ value: muxed.id }))
    wrapper.unmount()
  })
  it('uses audio-only controls for an audio presentation', () => {
    const { wrapper, model } = setup([{ ...muxed, type: 'audio', codec: 'mp4a', width: '0', height: '0' }])
    expect(model.value.video).toBe('none')
    expect(wrapper.find('[data-label="media.content"]').exists()).toBe(false)
    expect(wrapper.find('[data-label="media.video"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('recording duration', () => {
  it('keeps unlimited native value and exposes custom seconds only when requested', async () => {
    const { wrapper, model } = setup([muxed], true)
    const duration = wrapper.find('[data-label="media.record-time"]').findComponent({ name: 'Select' })
    expect(duration.props('value')).toBe(0)
    expect(duration.props('options')).toContainEqual({ value: 0, label: 'media.unlimited' })
    duration.vm.$emit('update:value', -1)
    await wrapper.vm.$nextTick()
    expect(model.value.recordTime).toBe(60)
    duration.vm.$emit('update:value', 1800)
    await wrapper.vm.$nextTick()
    expect(model.value.recordTime).toBe(1800)
    duration.vm.$emit('update:value', 0)
    await wrapper.vm.$nextTick()
    expect(model.value.recordTime).toBe(0)
    wrapper.unmount()
  })
})
