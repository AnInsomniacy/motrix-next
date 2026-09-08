import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { ENGINE_RECOVERY_SUCCESS_DURATION } from '@shared/timing'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => ({ error: vi.fn() }),
}))
vi.mock('@vicons/ionicons5', () => {
  const icon = { template: '<i />' }
  return { CheckmarkCircleOutline: icon, CheckmarkOutline: icon, CloseCircleOutline: icon }
})
vi.mock('naive-ui', () => ({
  NModal: {
    props: ['show'],
    template: '<div v-if="show" class="modal-stub"><slot /></div>',
  },
  NButton: {
    props: ['loading', 'disabled', 'type'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NIcon: { template: '<span><slot /></span>' },
  NSpin: { template: '<span class="spin-stub" />' },
}))

import EngineRecoveryDialog from '@/components/layout/EngineRecoveryDialog.vue'
import { useEngineStore, type EngineSnapshot } from '@/stores/engine'

function recoverySnapshot(phase: EngineSnapshot['phase']): EngineSnapshot {
  return {
    phase,
    desired: 'running',
    revision: 1,
    operationId: 1,
    attempt: 2,
    maxAttempts: 5,
    cause: 'startup',
    failure: {
      stage: 'probe',
      message: 'RPC unavailable',
      retryable: true,
      exitCode: 28,
      signal: null,
      stderrTail: ['Exception caught', 'bt-encryption contains an unsupported value'],
    },
  }
}

describe('EngineRecoveryDialog', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
  })

  it('keeps the completed state visible before dismissing it', async () => {
    vi.useFakeTimers()
    const store = useEngineStore()
    store.snapshot = recoverySnapshot('probing')
    const wrapper = mount(EngineRecoveryDialog)

    store.snapshot = { ...recoverySnapshot('running'), revision: 2 }
    await nextTick()
    await nextTick()

    expect(wrapper.find('.modal-stub').exists()).toBe(true)
    expect(wrapper.text()).toContain('preferences.engine-restarted')

    await vi.advanceTimersByTimeAsync(ENGINE_RECOVERY_SUCCESS_DURATION - 1)
    expect(wrapper.find('.modal-stub').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.find('.modal-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('stays mounted across the complete automatic recovery operation', async () => {
    const store = useEngineStore()
    store.snapshot = recoverySnapshot('recovering')
    const wrapper = mount(EngineRecoveryDialog)

    expect(wrapper.find('.modal-stub').exists()).toBe(true)
    expect(wrapper.text()).toContain('2 / 5')
    expect(wrapper.text()).toContain('app.engine-stage-stop')
    expect(wrapper.text()).not.toContain('%')
    expect(wrapper.findAll('.engine-recovery-stage').map((stage) => stage.attributes('data-state'))).toEqual([
      'active',
      'pending',
      'pending',
    ])
    expect(wrapper.findAll('.engine-stage-dot')).toHaveLength(3)

    for (const phase of ['preparing', 'starting', 'probing', 'initializing', 'stabilizing'] as const) {
      store.snapshot = { ...recoverySnapshot(phase), revision: store.snapshot.revision + 1 }
      await nextTick()
      expect(wrapper.find('.modal-stub').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('%')
    }

    expect(wrapper.findAll('.engine-recovery-stage').map((stage) => stage.attributes('data-state'))).toEqual([
      'complete',
      'complete',
      'active',
    ])
    expect(wrapper.findAll('.engine-stage-dot')).toHaveLength(3)
  })

  it('reserves the retry counter from the first stopping frame', () => {
    const store = useEngineStore()
    store.snapshot = { ...recoverySnapshot('stopping'), attempt: 0, cause: 'manualRestart' }
    const wrapper = mount(EngineRecoveryDialog)

    expect(wrapper.text()).toContain('0 / 5')
    expect(wrapper.find('.engine-attempt').exists()).toBe(true)
  })

  it('animates the error into the recovering layout without replacing the stage track', async () => {
    const store = useEngineStore()
    store.snapshot = { ...recoverySnapshot('probing'), failure: null }
    const wrapper = mount(EngineRecoveryDialog)
    const stageTrack = wrapper.find('.engine-stage-track').element

    store.snapshot = { ...recoverySnapshot('probing'), revision: 2 }
    await nextTick()

    expect(wrapper.find('.engine-error-block').exists()).toBe(true)
    expect(wrapper.find('.engine-stage-track').element).toBe(stageTrack)
  })

  it('shows the engine error and recovery actions after retries are exhausted', async () => {
    const store = useEngineStore()
    store.snapshot = { ...recoverySnapshot('failed'), attempt: 5 }
    const recover = vi.spyOn(store, 'recoverRuntimeState').mockResolvedValue(store.snapshot)
    const wrapper = mount(EngineRecoveryDialog)

    expect(wrapper.text()).toContain('bt-encryption contains an unsupported value')
    const cleanup = wrapper.findAll('button').find((button) => button.text() === 'app.engine-reset-state')
    expect(cleanup).toBeDefined()
    await cleanup?.trigger('click')
    expect(recover).toHaveBeenCalledOnce()
  })
})
