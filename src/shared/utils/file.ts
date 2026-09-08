/** @fileoverview Filename and extension parsing. */

export const getFileName = (fullPath: string): string => {
  return fullPath.replace(/^.*[/\\]/, '')
}

export const getFileExtension = (filename: string): string => {
  return filename.slice(((filename.lastIndexOf('.') - 1) >>> 0) + 2)
}
