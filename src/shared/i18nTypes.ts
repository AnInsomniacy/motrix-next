/** @fileoverview Translation key types derived from the canonical en-US resource. */
import enUS from '@shared/locales/en-US/messages.json'

type LeafPaths<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : T[Key] extends Record<string, unknown>
      ? `${Key}.${LeafPaths<T[Key]>}`
      : never
}[keyof T & string]

export type I18nKey = LeafPaths<typeof enUS>
