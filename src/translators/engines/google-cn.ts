import GoogleTranslate from './google'

export default class GoogleTranslateCN extends GoogleTranslate {
  get id() {
    return 'google-cn'
  }

  link = 'https://translate.google.cn'
  apiRoot = 'https://translate.google.cn'

  // 国内镜像没有 /languages 端点，沿用内置声明
  async fetchSupportedLocales() {
    return undefined
  }
}
