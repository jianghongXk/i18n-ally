import { KeyStyle } from '../core/types'
import { ROOT_KEY } from './flat'
import { Node, LocaleTree, LocaleNode, LocaleRecord, Config } from '~/core'

export function caseInsensitiveMatch(a: string, b: string) {
  return a.toUpperCase() === b.toUpperCase()
}

export function getKeyname(keypath: string) {
  const keys = keypath.split(/\./g)
  if (!keys.length)
    return ''
  return keys[keys.length - 1]
}

export function notEmpty<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

export function escapeMarkdown(text: string) {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

export function resolveFlattenRootKeypath(keypath: string) {
  if (keypath.endsWith(ROOT_KEY))
    keypath = keypath.slice(0, -ROOT_KEY.length)
  if (keypath.endsWith('.'))
    keypath = keypath.slice(0, -1)
  return keypath
}

export function resolveFlattenRoot (node: undefined): undefined
export function resolveFlattenRoot (node: LocaleRecord): LocaleRecord
export function resolveFlattenRoot (node: LocaleTree | LocaleNode): LocaleTree | LocaleNode
export function resolveFlattenRoot (node?: LocaleTree | LocaleNode): LocaleTree | LocaleNode | undefined
export function resolveFlattenRoot(node?: Node) {
  if (node?.type === 'tree' && node.getChild(ROOT_KEY)?.type === 'node')
    return node.getChild(ROOT_KEY)
  return node
}

export function set(obj: any, key: string, value: any, override = true) {
  if (Array.isArray(obj)) {
    const num = parseInt(key)
    if (!isNaN(num)) {
      if (override || obj[num] == null)
        obj[num] = value
      return obj[num]
    }
  }
  if (override || obj[key] == null)
    obj[key] = value
  return obj[key]
}

export function setNested(obj: any, keys: string[], value: any) {
  if (!keys.length)
    return
  const key = keys[0]
  if (keys.length === 1) { set(obj, key, value) }
  else {
    const existing = obj[key]
    if (existing && typeof existing === 'object' && !Array.isArray(existing))
      setNested(existing, keys.slice(1), value)

    else
      setNested(set(obj, key, {}, false), keys.slice(1), value)
  }
}

export function applyPendingToObject(obj: any, keypath: string, value: any, keyStyle?: KeyStyle) {
  if (!Config.disablePathParsing)
    keypath = resolveFlattenRootKeypath(keypath)

  if (keyStyle === 'flat') {
    // 项目里可能同时存在「嵌套对象」和「点号字面 key」两种历史结构。
    // 若该 keypath 在嵌套结构里已有标量值（哪怕是空串），就更新嵌套位置；
    // 否则新建一个同名字面 key 会造成重复定义，vue-i18n 走嵌套路径读不到它，
    // 表现为「翻译写进去了，hover 还是空」。
    // 只在「同名字面 key 还不存在」时才走嵌套，避免改动项目里已有的
    // 字面 key（这种混合结构里两种 key 可能同时存在且都在用）。
    const parts = keypath.split('.')
    if (parts.length > 1 && !(keypath in obj)) {
      let cursor = obj
      let nested = true
      for (const part of parts.slice(0, -1)) {
        if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)
          && part in cursor && cursor[part] && typeof cursor[part] === 'object') { cursor = cursor[part] }
        else {
          nested = false
          break
        }
      }
      const last = parts[parts.length - 1]
      if (nested && cursor && typeof cursor === 'object'
        && last in cursor && (cursor[last] === null || typeof cursor[last] !== 'object')) {
        cursor[last] = value
        return obj
      }
    }
    obj[keypath] = value
  }
  else {
    setNested(obj, keypath.split(/\./g), value)
  }

  return obj
}

// abbreviateNumber source https://gist.github.com/tobyjsullivan/96d37ca0216adee20fa95fe1c3eb56ac

export function abbreviateNumber(value: number): string {
  let newValue = value
  const suffixes = ['', 'K', 'M', 'B', 'T']
  let suffixNum = 0
  while (newValue >= 1000) {
    newValue /= 1000
    suffixNum++
  }

  let result = newValue.toPrecision(3)

  result += suffixes[suffixNum]
  return result
}

/**
 * Get a locale aware comparison function
 */
export function getLocaleCompare(
  sortLocaleSetting: string | undefined,
  fileLocale: string,
): (x: string, y: string) => number {
  const sortLocale = sortLocaleSetting || fileLocale
  return new Intl.Collator(sortLocale).compare
}
