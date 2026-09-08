import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { localFileUrlToPath, parseTableChildren, rowsToMarkdown, rowsToTsv } from './message'

describe('localFileUrlToPath', () => {
  test('normalizes a Windows file URL to an absolute Windows path', () => {
    expect(localFileUrlToPath('file:///C:/Users/yuan/Documents/report%20final.md'))
      .toBe('C:/Users/yuan/Documents/report final.md')
  })

  test('preserves an absolute Unix file path', () => {
    expect(localFileUrlToPath('file:///tmp/profer/report.md')).toBe('/tmp/profer/report.md')
  })

  test('allows localhost but rejects remote-host file URLs', () => {
    expect(localFileUrlToPath('file://localhost/C:/workspace/readme.md'))
      .toBe('C:/workspace/readme.md')
    expect(localFileUrlToPath('file://server/share/secret.md')).toBeNull()
  })

  test('rejects non-file URLs', () => {
    expect(localFileUrlToPath('https://example.com/report.md')).toBeNull()
  })
})

describe('parseTableChildren', () => {
  test('extracts a 2D plain-text grid from thead/tbody → tr → th/td', () => {
    const table = React.createElement('table', {
      children: [
        React.createElement('thead', {
          children: React.createElement('tr', {
            children: [
              React.createElement('th', { children: '姓名' }),
              React.createElement('th', { children: '年龄' }),
            ],
          }),
        }),
        React.createElement('tbody', {
          children: [
            React.createElement('tr', {
              children: [
                React.createElement('td', { children: '张三' }),
                React.createElement('td', { children: '28' }),
              ],
            }),
            React.createElement('tr', {
              children: [
                React.createElement('td', { children: '李四' }),
                React.createElement('td', { children: '35' }),
              ],
            }),
          ],
        }),
      ],
    })

    expect(parseTableChildren((table.props as { children?: React.ReactNode }).children)).toEqual([
      ['姓名', '年龄'],
      ['张三', '28'],
      ['李四', '35'],
    ])
  })

  test('flattens nested inline elements inside cells into plain text', () => {
    const table = React.createElement('table', {
      children: React.createElement('tbody', {
        children: React.createElement('tr', {
          children: React.createElement('td', {
            children: [
              '共 ',
              React.createElement('strong', { children: '3' }),
              ' 项',
            ],
          }),
        }),
      }),
    })

    expect(parseTableChildren((table.props as { children?: React.ReactNode }).children)).toEqual([
      ['共 3 项'],
    ])
  })
})

describe('rowsToTsv', () => {
  test('joins rows with newline and cells with tab', () => {
    expect(rowsToTsv([['姓名', '年龄'], ['张三', '28'], ['李四', '35']]))
      .toBe('姓名\t年龄\n张三\t28\n李四\t35')
  })

  test('collapses in-cell newlines to spaces so pasting stays clean', () => {
    expect(rowsToTsv([['第一行\n第二行', '值']])).toBe('第一行 第二行\t值')
  })
})

describe('rowsToMarkdown', () => {
  test('rebuilds a GFM table with header separator', () => {
    expect(rowsToMarkdown([['姓名', '年龄'], ['张三', '28'], ['李四', '35']]))
      .toBe('| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 28 |\n| 李四 | 35 |')
  })

  test('escapes pipe characters inside cells', () => {
    expect(rowsToMarkdown([['a|b', 'c']])).toBe('| a\\|b | c |\n| --- | --- |')
  })

  test('returns empty string for empty rows', () => {
    expect(rowsToMarkdown([])).toBe('')
  })
})
