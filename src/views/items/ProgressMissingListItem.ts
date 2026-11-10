import { ProgressRootItem } from './ProgressRootItem'
import { ProgressSubmenuItem } from './ProgressSubmenuItem'
import { Config, CurrentFile } from '~/core'

export class ProgressMissingListItem extends ProgressSubmenuItem {
  constructor(protected root: ProgressRootItem) {
    super(root, 'view.progress_submenu.missing_keys', 'icon-unknown')
  }

  // @ts-expect-error
  get contextValue() {
    const values: string[] = ['progress-submenu-missing']
    if (!Config.isSameLocale(this.node.locale, Config.alignToProject(CurrentFile.loader?.locales)))
      values.push('translatable')
    values.push('fulfillable')
    return values.join('-')
  }

  getKeys() {
    return this.root.node.missingKeys
  }
}
