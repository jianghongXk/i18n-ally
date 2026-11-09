import { TreeItem, ExtensionContext, TreeDataProvider, EventEmitter, Event } from 'vscode'
import { throttle } from 'lodash'
import { LocaleTreeItem } from '../items/LocaleTreeItem'
import { EditorPanel } from '../../webview/panel'
import { THROTTLE_DELAY } from '../../meta'
import { resolveFlattenRootKeypath } from '~/utils'
import { Node, Loader, CurrentFile, LocaleTree, LocaleNode } from '~/core'

const HAS_ALPHA = /[A-Za-z]/

/**
 * 翻译树的 key 排序：带字母的 key 全部排在上面（按字符串序），
 * 纯数字的排在下面并按数值大小排。这样随机码 key 不会被后端数字码打断。
 */
function compareKeypath(a: string, b: string) {
  const aAlpha = HAS_ALPHA.test(a)
  const bAlpha = HAS_ALPHA.test(b)

  if (aAlpha !== bAlpha)
    return aAlpha ? -1 : 1

  if (!aAlpha) {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb)
      return na - nb
  }

  return a < b ? -1 : a > b ? 1 : 0
}

export class LocalesTreeProvider implements TreeDataProvider<LocaleTreeItem> {
  protected loader: Loader
  protected name = 'LocalesTreeProvider'
  private _flatten: boolean
  private _onDidChangeTreeData: EventEmitter<LocaleTreeItem | undefined> = new EventEmitter<LocaleTreeItem | undefined>()
  readonly onDidChangeTreeData: Event<LocaleTreeItem | undefined> = this._onDidChangeTreeData.event

  constructor(
    public readonly ctx: ExtensionContext,
    public includePaths?: string[],
    flatten = false,
  ) {
    this._flatten = flatten
    this.loader = CurrentFile.loader

    const throttledRefresh = throttle(() => this.refresh(), THROTTLE_DELAY)
    this.loader.onDidChange(throttledRefresh)
    EditorPanel.onDidChange(throttledRefresh)
  }

  protected refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  getTreeItem(element: LocaleTreeItem): TreeItem {
    return element
  }

  get flatten() {
    return this._flatten
  }

  set flatten(value) {
    if (this._flatten !== value) {
      this._flatten = value
      this.refresh()
    }
  }

  private filter(node: Node, root = false): boolean {
    if (!this.includePaths)
      return true

    const flatten = resolveFlattenRootKeypath(node.keypath)

    for (const includePath of this.includePaths) {
      if (includePath.startsWith(node.keypath))
        return true
      if (!root && node.keypath.startsWith(includePath))
        return true
      if (this.flatten && flatten !== node.keypath && flatten === includePath)
        return true
    }
    return false
  }

  protected filterNodes(nodes: (LocaleTree | LocaleNode)[]) {
    return nodes
  }

  protected getRoots() {
    if (!this.loader)
      return []

    const nodes = this.flatten
      ? Object.values(this.loader.flattenLocaleTree)
      : Object.values(this.loader.root.children)

    return nodes
      .filter(node => this.filter(node, true))
      .map(node => new LocaleTreeItem(this.ctx, node, this.flatten))
  }

  sort(elements: LocaleTreeItem[]) {
    return [...elements].sort((a, b) => {
      // 先按节点类型（node < record < tree），与原 sortBy 行为一致
      if (a.node.type !== b.node.type)
        return a.node.type < b.node.type ? -1 : 1
      return compareKeypath(a.node.keypath, b.node.keypath)
    })
  }

  async getChildren(element?: LocaleTreeItem) {
    let elements: LocaleTreeItem[] = []

    if (element)
      elements = await element.getChildren(node => this.filter(node, true))
    else
      elements = this.getRoots()

    return this.sort(elements)
  }
}
