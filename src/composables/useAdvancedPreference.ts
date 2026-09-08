/** Advanced settings own RPC, extension access, logging, and clipboard behavior. */
import { PORT_RECOVERY_RANGE_END, PORT_RECOVERY_RANGE_START } from '@shared/constants'
import { generateRandomInt } from '@shared/utils'
import type { AppConfig } from '@shared/types'

export interface AdvancedForm {
  [key: string]: unknown
  rpcListenPort: number
  rpcSecret: string
  extensionApiPort: number
  extensionApiSecret: string
  allowRemoteAccess: boolean
  useIndependentDownloadWindow: boolean
  autoSubmitFromExtension: boolean
  silentAutoSubmitFromExtension: boolean
  logLevel: AppConfig['logLevel']
  aria2LogLevel: AppConfig['aria2LogLevel']
  tempFilesDir: string
  hardwareRendering: boolean
  clipboardEnable: boolean
  clipboardHttp: boolean
  clipboardSftp: boolean
  clipboardMagnet: boolean
  clipboardEd2k: boolean
  clipboardThunder: boolean
  clipboardBtHash: boolean
}

export function buildAdvancedForm(config: AppConfig): AdvancedForm {
  return {
    rpcListenPort: config.rpcListenPort,
    rpcSecret: config.rpcSecret,
    extensionApiPort: config.extensionApiPort,
    extensionApiSecret: config.extensionApiSecret,
    allowRemoteAccess: config.allowRemoteAccess,
    useIndependentDownloadWindow: config.useIndependentDownloadWindow,
    autoSubmitFromExtension: config.autoSubmitFromExtension,
    silentAutoSubmitFromExtension: config.silentAutoSubmitFromExtension,
    logLevel: config.logLevel,
    aria2LogLevel: config.aria2LogLevel,
    tempFilesDir: config.tempFilesDir,
    hardwareRendering: config.hardwareRendering,
    clipboardEnable: config.clipboard.enable,
    clipboardHttp: config.clipboard.http,
    clipboardSftp: config.clipboard.sftp,
    clipboardMagnet: config.clipboard.magnet,
    clipboardEd2k: config.clipboard.ed2k,
    clipboardThunder: config.clipboard.thunder,
    clipboardBtHash: config.clipboard.btHash,
  }
}

export function buildAdvancedSystemConfig(form: AdvancedForm): Record<string, string> {
  return {
    'rpc-listen-port': String(form.rpcListenPort),
    'allow-remote-access': String(form.allowRemoteAccess),
    'rpc-secret': form.rpcSecret,
  }
}

export function transformAdvancedForStore(form: AdvancedForm): Partial<AppConfig> {
  const {
    clipboardEnable,
    clipboardHttp,
    clipboardSftp,
    clipboardMagnet,
    clipboardEd2k,
    clipboardThunder,
    clipboardBtHash,
    ...rest
  } = form
  return {
    ...rest,
    clipboard: {
      enable: clipboardEnable,
      http: clipboardHttp,
      sftp: clipboardSftp,
      magnet: clipboardMagnet,
      ed2k: clipboardEd2k,
      thunder: clipboardThunder,
      btHash: clipboardBtHash,
    },
  }
}

export function randomRpcPort(): number {
  return generateRandomInt(PORT_RECOVERY_RANGE_START, PORT_RECOVERY_RANGE_END + 1)
}
