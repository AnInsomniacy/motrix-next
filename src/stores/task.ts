import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { EMPTY_STRING, TASK_STATUS } from '@shared/constants'
import { bytesToSize, checkTaskIsBT, intersection } from '@shared/utils'
import { usePreferenceStore } from './preference'

interface TaskItem {
    gid: string
    status: string
    totalLength: string
    completedLength: string
    downloadSpeed: string
    uploadSpeed: string
    files: TaskFile[]
    bittorrent?: { info?: { name: string }; announceList?: string[] }
    infoHash?: string
    seeder?: string
    peers?: unknown[]
    [key: string]: unknown
}

interface TaskFile {
    path: string
    length: string
    selected: string
    uris: { uri: string }[]
    [key: string]: unknown
}

interface Api {
    fetchTaskList: (params: { type: string }) => Promise<TaskItem[]>
    fetchTaskItem: (params: { gid: string }) => Promise<TaskItem>
    fetchTaskItemWithPeers: (params: { gid: string }) => Promise<TaskItem>
    addUri: (params: { uris: string[]; outs: string[]; options: Record<string, unknown> }) => Promise<unknown>
    addTorrent: (params: { torrent: string; options: Record<string, unknown> }) => Promise<unknown>
    addMetalink: (params: { metalink: string; options: Record<string, unknown> }) => Promise<unknown>
    getOption: (params: { gid: string }) => Promise<Record<string, unknown>>
    changeOption: (params: { gid: string; options: Record<string, unknown> }) => Promise<unknown>
    removeTask: (params: { gid: string }) => Promise<unknown>
    forcePauseTask: (params: { gid: string }) => Promise<unknown>
    pauseTask: (params: { gid: string }) => Promise<unknown>
    resumeTask: (params: { gid: string }) => Promise<unknown>
    pauseAllTask: () => Promise<unknown>
    forcePauseAllTask: () => Promise<unknown>
    resumeAllTask: () => Promise<unknown>
    batchResumeTask: (params: { gids: string[] }) => Promise<unknown>
    batchPauseTask: (params: { gids: string[] }) => Promise<unknown>
    batchForcePauseTask: (params: { gids: string[] }) => Promise<unknown>
    batchRemoveTask: (params: { gids: string[] }) => Promise<unknown>
    removeTaskRecord: (params: { gid: string }) => Promise<unknown>
    purgeTaskRecord: () => Promise<unknown>
    saveSession: () => Promise<unknown>
    fetchActiveTaskList: () => Promise<TaskItem[]>
}

export const useTaskStore = defineStore('task', () => {
    const currentList = ref('active')
    const taskDetailVisible = ref(false)
    const currentTaskGid = ref(EMPTY_STRING)
    const enabledFetchPeers = ref(false)
    const currentTaskItem = ref<TaskItem | null>(null)
    const currentTaskFiles = ref<TaskFile[]>([])
    const currentTaskPeers = ref<unknown[]>([])
    const seedingList = ref<string[]>([])
    const taskList = ref<TaskItem[]>([])
    const selectedGidList = ref<string[]>([])

    let api: Api

    function setApi(a: Api) {
        api = a
    }

    async function changeCurrentList(list: string) {
        currentList.value = list
        selectedGidList.value = []
        await fetchList()
    }

    async function fetchList() {
        try {
            const data = await api.fetchTaskList({ type: currentList.value })
            taskList.value = data
            const gids = data.map((task) => task.gid)
            selectedGidList.value = intersection(selectedGidList.value, gids)
            if (taskDetailVisible.value && currentTaskGid.value) {
                const fresh = data.find((t) => t.gid === currentTaskGid.value)
                if (fresh) updateCurrentTaskItem(fresh)
            }
            updateTraySpeed(data)
        } catch (e) {
            console.warn((e as Error).message)
        }
    }

    function updateTraySpeed(tasks: TaskItem[]) {
        const prefStore = usePreferenceStore()
        const enabled = prefStore.config?.traySpeedometer
        if (!enabled) {
            invoke('update_tray_title', { title: '' }).catch(() => { })
            return
        }
        let totalDown = 0
        let totalUp = 0
        for (const t of tasks) {
            if (t.status === TASK_STATUS.ACTIVE) {
                totalDown += Number(t.downloadSpeed) || 0
                totalUp += Number(t.uploadSpeed) || 0
            }
        }
        const downStr = totalDown > 0 ? `↓ ${bytesToSize(totalDown)}/s` : ''
        const upStr = totalUp > 0 ? `↑ ${bytesToSize(totalUp)}/s` : ''
        const title = [downStr, upStr].filter(Boolean).join(' ')
        invoke('update_tray_title', { title }).catch(() => { })
    }

    function selectTasks(list: string[]) {
        selectedGidList.value = list
    }

    function selectAllTask() {
        selectedGidList.value = taskList.value.map((task) => task.gid)
    }

    async function fetchItem(gid: string) {
        const data = await api.fetchTaskItem({ gid })
        updateCurrentTaskItem(data)
    }

    function showTaskDetail(task: TaskItem) {
        updateCurrentTaskItem(task)
        currentTaskGid.value = task.gid
        taskDetailVisible.value = true
    }

    async function showTaskDetailByGid(gid: string) {
        const task = await api.fetchTaskItem({ gid })
        showTaskDetail(task)
    }

    function hideTaskDetail() {
        taskDetailVisible.value = false
    }

    function updateCurrentTaskItem(task: TaskItem | null) {
        currentTaskItem.value = task
        if (task) {
            currentTaskFiles.value = task.files
            currentTaskPeers.value = task.peers || []
        } else {
            currentTaskFiles.value = []
            currentTaskPeers.value = []
        }
    }

    async function addUri(data: { uris: string[]; outs: string[]; options: Record<string, unknown> }) {
        await api.addUri(data)
        await fetchList()
    }

    async function addTorrent(data: { torrent: string; options: Record<string, unknown> }) {
        await api.addTorrent(data)
        await fetchList()
    }

    async function addMetalink(data: { metalink: string; options: Record<string, unknown> }) {
        await api.addMetalink(data)
        await fetchList()
    }

    async function getTaskOption(gid: string) {
        return api.getOption({ gid })
    }

    async function changeTaskOption(payload: { gid: string; options: Record<string, unknown> }) {
        return api.changeOption(payload)
    }

    async function removeTask(task: TaskItem) {
        if (task.gid === currentTaskGid.value) hideTaskDetail()
        try {
            await api.removeTask({ gid: task.gid })
        } finally {
            await fetchList()
            api.saveSession()
        }
    }

    async function pauseTask(task: TaskItem) {
        const isBT = checkTaskIsBT(task as never)
        const promise = isBT ? api.forcePauseTask({ gid: task.gid }) : api.pauseTask({ gid: task.gid })
        try {
            await promise
        } finally {
            await fetchList()
            api.saveSession()
        }
    }

    async function resumeTask(task: TaskItem) {
        try {
            await api.resumeTask({ gid: task.gid })
        } finally {
            await fetchList()
            api.saveSession()
        }
    }

    async function pauseAllTask() {
        try {
            await api.pauseAllTask()
        } catch {
            await api.forcePauseAllTask()
        } finally {
            await fetchList()
            api.saveSession()
        }
    }

    async function resumeAllTask() {
        try {
            await api.resumeAllTask()
        } finally {
            await fetchList()
            api.saveSession()
        }
    }

    async function toggleTask(task: TaskItem) {
        const { status } = task
        if (status === TASK_STATUS.ACTIVE) return pauseTask(task)
        if (status === TASK_STATUS.WAITING || status === TASK_STATUS.PAUSED) return resumeTask(task)
    }

    function addToSeedingList(gid: string) {
        if (seedingList.value.includes(gid)) return
        seedingList.value = [...seedingList.value, gid]
    }

    function removeFromSeedingList(gid: string) {
        const idx = seedingList.value.indexOf(gid)
        if (idx === -1) return
        seedingList.value = [...seedingList.value.slice(0, idx), ...seedingList.value.slice(idx + 1)]
    }

    async function stopSeeding(gid: string) {
        return changeTaskOption({ gid, options: { seedTime: 0 } })
    }

    async function removeTaskRecord(task: TaskItem) {
        const { gid, status } = task
        if (gid === currentTaskGid.value) hideTaskDetail()
        const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
        if ([ERROR, COMPLETE, REMOVED].indexOf(status) === -1) return
        try {
            await api.removeTaskRecord({ gid })
        } finally {
            await fetchList()
        }
    }

    async function purgeTaskRecord() {
        try {
            await api.purgeTaskRecord()
        } finally {
            await fetchList()
        }
    }

    function saveSession() {
        api.saveSession()
    }

    async function batchResumeSelectedTasks() {
        if (selectedGidList.value.length === 0) return
        return api.batchResumeTask({ gids: selectedGidList.value })
    }

    async function batchPauseSelectedTasks() {
        if (selectedGidList.value.length === 0) return
        return api.batchPauseTask({ gids: selectedGidList.value })
    }

    async function batchRemoveTask(gids: string[]) {
        try {
            await api.batchRemoveTask({ gids })
        } finally {
            await fetchList()
            api.saveSession()
        }
    }

    return {
        currentList,
        taskDetailVisible,
        currentTaskGid,
        enabledFetchPeers,
        currentTaskItem,
        currentTaskFiles,
        currentTaskPeers,
        seedingList,
        taskList,
        selectedGidList,
        setApi,
        changeCurrentList,
        fetchList,
        selectTasks,
        selectAllTask,
        fetchItem,
        showTaskDetail,
        showTaskDetailByGid,
        hideTaskDetail,
        updateCurrentTaskItem,
        addUri,
        addTorrent,
        addMetalink,
        getTaskOption,
        changeTaskOption,
        removeTask,
        pauseTask,
        resumeTask,
        pauseAllTask,
        resumeAllTask,
        toggleTask,
        addToSeedingList,
        removeFromSeedingList,
        stopSeeding,
        removeTaskRecord,
        purgeTaskRecord,
        saveSession,
        batchResumeSelectedTasks,
        batchPauseSelectedTasks,
        batchRemoveTask,
    }
})
