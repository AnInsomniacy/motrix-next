import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export function useIpc() {
    async function call<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
        return invoke<T>(command, args)
    }

    async function on<T = unknown>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
        return listen<T>(event, (e) => handler(e.payload))
    }

    async function startEngine(): Promise<void> {
        return call('start_engine_command')
    }

    async function stopEngine(): Promise<void> {
        return call('stop_engine_command')
    }

    async function restartEngine(): Promise<void> {
        return call('restart_engine_command')
    }

    async function factoryReset(): Promise<void> {
        return call('factory_reset')
    }

    async function getAppConfig(): Promise<Record<string, unknown>> {
        return call('get_app_config')
    }

    async function savePreference(config: Record<string, unknown>): Promise<void> {
        return call('save_preference', { config })
    }

    async function getSystemConfig(): Promise<Record<string, unknown>> {
        return call('get_system_config')
    }

    async function saveSystemConfig(config: Record<string, unknown>): Promise<void> {
        return call('save_system_config', { config })
    }

    return {
        call,
        on,
        startEngine,
        stopEngine,
        restartEngine,
        factoryReset,
        getAppConfig,
        savePreference,
        getSystemConfig,
        saveSystemConfig,
    }
}
