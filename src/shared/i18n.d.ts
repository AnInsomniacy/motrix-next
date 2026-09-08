import enUS from '@shared/locales/en-US/messages.json'

type MessageSchema = typeof enUS

declare module 'vue-i18n' {
  export interface DefineLocaleMessage extends MessageSchema {}
}
