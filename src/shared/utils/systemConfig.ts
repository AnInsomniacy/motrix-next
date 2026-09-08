import { buildAdvancedForm, buildAdvancedSystemConfig } from '@/composables/useAdvancedPreference'
import { buildBtForm, buildBtSystemConfig } from '@/composables/useBtPreference'
import { buildDownloadsForm, buildDownloadsSystemConfig } from '@/composables/useDownloadsPreference'
import { buildEd2kForm, buildEd2kSystemConfig } from '@/composables/useEd2kPreference'
import { buildNetworkForm, buildNetworkSystemConfig } from '@/composables/useNetworkPreference'
import type { AppConfig } from '@shared/types'

export function buildSystemConfigFromAppConfig(config: AppConfig, defaultDir = ''): Record<string, string> {
  const downloadsSystem = buildDownloadsSystemConfig(buildDownloadsForm(config, defaultDir))
  const btSystem = buildBtSystemConfig(buildBtForm(config))
  const networkSystem = buildNetworkSystemConfig(buildNetworkForm(config))
  const ed2kSystem = buildEd2kSystemConfig(buildEd2kForm(config))
  const advancedSystem = buildAdvancedSystemConfig(buildAdvancedForm(config))

  return {
    ...downloadsSystem,
    ...btSystem,
    ...networkSystem,
    ...ed2kSystem,
    ...advancedSystem,
  }
}
