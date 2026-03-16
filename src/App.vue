<script setup lang="ts">
/** @fileoverview Root application component with Naive UI theme provider and locale configuration. */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  darkTheme,
  type GlobalThemeOverrides,
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

const { locale: currentLocale } = useI18n()
const { isDark } = useTheme()
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

const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const outline = isDark.value ? '#4d4639' : '#d1c7b7'
  const outlineFull = isDark.value ? '#998f80' : '#7f7667'
  return {
    common: {
      primaryColor: '#E0A422',
      primaryColorHover: isDark.value ? '#f0bf48' : '#c89319',
      primaryColorPressed: isDark.value ? '#d4a530' : '#b38417',
      primaryColorSuppl: '#E0A422',
      bodyColor: 'transparent',
      cardColor: isDark.value ? '#201e1b' : '#f3efe8',
      modalColor: isDark.value ? '#2b2926' : '#ede9e2',
      popoverColor: isDark.value ? '#2b2926' : '#ede9e2',
      borderColor: outline,
      dividerColor: outline,
      borderRadius: '6px',
      fontFamily:
        '"Monospaced Number", "Chinese Quote", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
    },
    Divider: {
      color: outline,
    },
    Button: {
      border: `1px solid ${outline}`,
      borderHover: `1px solid ${outlineFull}`,
      borderFocus: `1px solid ${outlineFull}`,
    },
    Input: {
      border: `1px solid ${outline}`,
      borderHover: `1px solid ${outlineFull}`,
      borderFocus: `1px solid ${outlineFull}`,
    },
    Card: {
      borderColor: outline,
    },
  }
})
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
        <router-view />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
#app {
  height: 100%;
}
</style>
