<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NConfigProvider, NMessageProvider, NDialogProvider,
  darkTheme, type GlobalThemeOverrides,
  zhCN, zhTW, jaJP, koKR, ruRU, frFR, deDE, esAR, ptBR,
  itIT, trTR, idID, viVN, plPL, thTH, arDZ, ukUA, nlNL, nbNO,
  dateZhCN, dateZhTW, dateJaJP, dateKoKR, dateRuRU, dateFrFR, dateDeDE, dateEsAR, datePtBR,
  dateItIT, dateTrTR, dateIdID, dateViVN, datePlPL, dateThTH, dateArDZ, dateUkUA, dateNlNL, dateNbNO,
} from 'naive-ui'
import { useTheme } from './composables/useTheme'

const { locale: currentLocale } = useI18n()
const { isDark } = useTheme()

const theme = computed(() => isDark.value ? darkTheme : null)

const naiveLocaleMap: Record<string, unknown> = {
  'zh-CN': zhCN, 'zh-TW': zhTW, ja: jaJP, ko: koKR,
  ru: ruRU, fr: frFR, de: deDE, es: esAR, 'pt-BR': ptBR,
  it: itIT, tr: trTR, id: idID, vi: viVN, pl: plPL,
  th: thTH, ar: arDZ, uk: ukUA, nl: nlNL, nb: nbNO,
}
const naiveDateLocaleMap: Record<string, unknown> = {
  'zh-CN': dateZhCN, 'zh-TW': dateZhTW, ja: dateJaJP, ko: dateKoKR,
  ru: dateRuRU, fr: dateFrFR, de: dateDeDE, es: dateEsAR, 'pt-BR': datePtBR,
  it: dateItIT, tr: dateTrTR, id: dateIdID, vi: dateViVN, pl: datePlPL,
  th: dateThTH, ar: dateArDZ, uk: dateUkUA, nl: dateNlNL, nb: dateNbNO,
}

const naiveLocale = computed(() => naiveLocaleMap[currentLocale.value] || null)
const naiveDateLocale = computed(() => naiveDateLocaleMap[currentLocale.value] || null)

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#E0A422',
    primaryColorHover: '#c89319',
    primaryColorPressed: '#b38417',
    primaryColorSuppl: '#E0A422',
    borderRadius: '4px',
    fontFamily: '"Monospaced Number", "Chinese Quote", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
  },
}
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides" :locale="naiveLocale as any" :date-locale="naiveDateLocale as any">
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