/** @fileoverview Barrel re-export for all utility sub-modules. */

export * from './format'
export * from './peer'
export * from './task'
export * from './file'
export * from './config'
export * from './resource'
export * from './locale'
export * from './clipboard'
export * from './hls'

export const generateRandomInt = (min = 0, max = 10000): number => {
  const range = max - min
  return min + Math.floor(Math.random() * Math.floor(range))
}

export const intersection = <T>(array1: T[] = [], array2: T[] = []): T[] => {
  if (array1.length === 0 || array2.length === 0) return []
  return array1.filter((value) => array2.includes(value))
}

export const pushItemToFixedLengthArray = <T>(arr: T[] = [], maxLength: number, item: T): T[] => {
  return arr.length >= maxLength ? [...arr.slice(1), item] : [...arr, item]
}

export const removeArrayItem = <T>(arr: T[] = [], item: T): T[] => {
  const idx = arr.indexOf(item)
  if (idx === -1) return [...arr]
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)]
}
