/** @fileoverview Serializes independent task dialogs without owning download state. */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export interface SelectionRequest {
  kind: 'bt' | 'media'
  gid: string
}

export const useTaskSelectionStore = defineStore('taskSelection', () => {
  const pending = ref<SelectionRequest[]>([])
  const queue = ref<SelectionRequest[]>([])
  const automatic = ref(new Set<string>())
  const deferred = ref(new Set<string>())
  const current = ref<SelectionRequest | null>(null)
  const phase = ref<'idle' | 'open' | 'closing'>('idle')
  const visible = computed(() => phase.value === 'open')

  function register(gid: string, prompt: boolean) {
    if (prompt) automatic.value.add(gid)
  }
  function request(item: SelectionRequest, auto = false) {
    if (auto && deferred.value.has(item.gid)) return
    if (!auto) deferred.value.delete(item.gid)
    if (item.gid !== current.value?.gid && !queue.value.some((entry) => entry.gid === item.gid)) queue.value.push(item)
  }
  function reconcile(waiting: SelectionRequest[], available: SelectionRequest[]) {
    pending.value = waiting
    const valid = new Set(available.map((item) => item.gid))
    queue.value = queue.value.filter((item) => valid.has(item.gid))
    for (const item of waiting) if (automatic.value.has(item.gid)) request(item, true)
    if (current.value && !valid.has(current.value.gid)) close()
  }
  function forget(gids: string[]) {
    const removed = new Set(gids)
    for (const gid of gids) {
      automatic.value.delete(gid)
      deferred.value.delete(gid)
    }
    pending.value = pending.value.filter((item) => !removed.has(item.gid))
    queue.value = queue.value.filter((item) => !removed.has(item.gid))
    if (current.value && removed.has(current.value.gid)) close()
  }
  function present() {
    if (phase.value !== 'idle') return
    const item = queue.value.shift()
    if (item) {
      current.value = item
      phase.value = 'open'
    }
  }
  function close() {
    if (!current.value || phase.value !== 'open') return
    deferred.value.add(current.value.gid)
    automatic.value.delete(current.value.gid)
    phase.value = 'closing'
  }
  function afterLeave() {
    if (phase.value !== 'closing') return
    current.value = null
    phase.value = 'idle'
  }
  return { pending, queue, current, phase, visible, register, request, reconcile, forget, present, close, afterLeave }
})
