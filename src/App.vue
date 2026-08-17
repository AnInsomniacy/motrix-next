<script setup lang="ts">
/** @fileoverview Root application component with Naive UI theme provider and locale configuration. */
import { computed, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  darkTheme,
  type NLocale,
  type NDateLocale,
  zhCN,
  zhTW,
  jaJP,
  koKR,
  ruRU,
  frFR,
  deDE,
  esAR,
  ptBR,
  itIT,
  trTR,
  idID,
  viVN,
  plPL,
  thTH,
  arDZ,
  ukUA,
  nlNL,
  nbNO,
  dateZhCN,
  dateZhTW,
  dateJaJP,
  dateKoKR,
  dateRuRU,
  dateFrFR,
  dateDeDE,
  dateEsAR,
  datePtBR,
  dateItIT,
  dateTrTR,
  dateIdID,
  dateViVN,
  datePlPL,
  dateThTH,
  dateArDZ,
  dateUkUA,
  dateNlNL,
  dateNbNO,
} from 'naive-ui'
import { useTheme } from './composables/useTheme'
import { useVisibilityPause } from './composables/useVisibilityPause'
import DownloadConfirmationView from './views/DownloadConfirmationView.vue'

import { APP_COLOR_TOKENS_KEY, useColorScheme } from './composables/useColorScheme'

const props = withDefaults(
  defineProps<{
    windowKind?: 'main' | 'download-confirmation'
  }>(),
  {
    windowKind: 'main',
  },
)

const { locale: currentLocale } = useI18n()
const { isDark } = useTheme()
const { colorTokens, themeOverrides } = useColorScheme()
provide(APP_COLOR_TOKENS_KEY, colorTokens)
useVisibilityPause()

const theme = computed(() => (isDark.value ? darkTheme : null))

const naiveLocaleMap: Record<string, NLocale> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja: jaJP,
  ko: koKR,
  ru: ruRU,
  fr: frFR,
  de: deDE,
  es: esAR,
  'pt-BR': ptBR,
  it: itIT,
  tr: trTR,
  id: idID,
  vi: viVN,
  pl: plPL,
  th: thTH,
  ar: arDZ,
  uk: ukUA,
  nl: nlNL,
  nb: nbNO,
}
const naiveDateLocaleMap: Record<string, NDateLocale> = {
  'zh-CN': dateZhCN,
  'zh-TW': dateZhTW,
  ja: dateJaJP,
  ko: dateKoKR,
  ru: dateRuRU,
  fr: dateFrFR,
  de: dateDeDE,
  es: dateEsAR,
  'pt-BR': datePtBR,
  it: dateItIT,
  tr: dateTrTR,
  id: dateIdID,
  vi: dateViVN,
  pl: datePlPL,
  th: dateThTH,
  ar: dateArDZ,
  uk: dateUkUA,
  nl: dateNlNL,
  nb: dateNbNO,
}

const naiveLocale = computed(() => naiveLocaleMap[currentLocale.value] || null)
const naiveDateLocale = computed(() => naiveDateLocaleMap[currentLocale.value] || null)
</script>

<template>
  <NConfigProvider
    :theme="theme"
    :theme-overrides="themeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NMessageProvider>
      <NDialogProvider>
        <DownloadConfirmationView v-if="props.windowKind === 'download-confirmation'" />
        <router-view v-else />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
#app {
  height: 100%;
}
</style>
