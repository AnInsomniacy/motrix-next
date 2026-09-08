import { describe, expect, it } from 'vitest'
import { getFileExtension, getFileName } from '../file'

describe('File utilities', () => {
  it('parses Unix and Windows filenames and compound extensions', () => {
    expect(getFileName('/home/user/archive.tar.gz')).toBe('archive.tar.gz')
    expect(getFileName('C:\\Users\\file.txt')).toBe('file.txt')
    expect(getFileExtension('archive.tar.gz')).toBe('gz')
    expect(getFileExtension('.gitignore')).toBe('')
  })
})
