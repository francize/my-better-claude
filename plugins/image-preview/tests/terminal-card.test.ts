// Run with: claude plugin test plugins/image-preview
import { expect, test } from 'claude-code/testing'

import { formatSize } from '../hooks/terminal-card'

test('sizes read in B, KB and MB, rounding to KB first', () => {
  expect(formatSize(0)).toBe('0 B')
  expect(formatSize(1023)).toBe('1023 B')
  expect(formatSize(1024)).toBe('1 KB')
  expect(formatSize(1024 * 1024 - 513)).toBe('1023 KB')
  expect(formatSize(1024 * 1024 - 1)).toBe('1.0 MB')
  expect(formatSize(5.25 * 1024 * 1024)).toBe('5.3 MB')
})
