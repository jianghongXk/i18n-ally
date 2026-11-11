// vsixmanifest 生成器。
//
// 存在的理由：这份 XML 原本整段写死在 pack-vsix.cjs 里，只有 Version 被替换，
// Id / Publisher / DisplayName / Description / Engine 全是硬编码 —— 一旦改
// package.json 的 name/publisher（比如把 fork 改成独立扩展以脱离原版轨道），
// 包里就会出现「manifest 说 A、package.json 说 B」的两套身份。
// VSCode 安装时以 vsixmanifest 的 Identity 定目录名、以 package.json 定扩展 id，
// 两者不一致会导致装出来的东西行为诡异（目录名和 id 对不上、卸载不干净）。
//
// 所以身份字段一律从 pkg 注入，这里不再出现任何字面量。
// 单独抽成模块的另一个好处是可以直接 require 进来断言，不必真的打一次包。

/** XML 文本与属性值转义。description 里有 emoji 和可能出现的 & / < */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 从 repository 字段取一个可点击的仓库地址（package.json 的 url 有两种写法） */
function repoUrl(pkg) {
  const r = pkg.repository
  if (!r)
    return ''
  return typeof r === 'string' ? r : (r.url || '')
}

/**
 * @param {object} pkg  package.json 内容
 * @returns {string}    extension.vsixmanifest 的 XML
 */
function buildManifest(pkg) {
  const version = String(pkg.version || '')
  const forcedPrerelease = pkg.engines && pkg.engines.__prerelease === true
  const isPrerelease = /-/.test(version) || forcedPrerelease

  const tags = (pkg.keywords || []).join(',')
  const categories = (pkg.categories || ['Other']).join(',')

  const props = [
    ['Microsoft.VisualStudio.Code.Engine', pkg.engines ? pkg.engines.vscode : undefined],
    ['Microsoft.VisualStudio.Code.ExtensionDependencies', ''],
    ['Microsoft.VisualStudio.Code.ExtensionPack', ''],
    ['Microsoft.VisualStudio.Code.ExtensionKind', 'workspace'],
    ['Microsoft.VisualStudio.Code.LocalizedLanguages', ''],
    isPrerelease ? ['Microsoft.VisualStudio.Code.PreRelease', 'true'] : null,
    repoUrl(pkg) ? ['Microsoft.VisualStudio.Services.Links.Source', repoUrl(pkg)] : null,
    pkg.homepage ? ['Microsoft.VisualStudio.Services.Links.Getstarted', pkg.homepage] : null,
    repoUrl(pkg) ? ['Microsoft.VisualStudio.Services.Links.GitHub', repoUrl(pkg)] : null,
    pkg.bugs ? ['Microsoft.VisualStudio.Services.Links.Support', pkg.bugs] : null,
    pkg.homepage ? ['Microsoft.VisualStudio.Services.Links.Learn', pkg.homepage] : null,
  ].filter(Boolean)

  const propsXml = props
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `      <Property Id="${esc(k)}" Value="${esc(v)}" />`)
    .join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc(tags)}</Tags>
    <Categories>${esc(categories)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Badges></Badges>
    <Properties>
${propsXml}
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${esc(pkg.icon || 'res/logo.png')}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon || 'res/logo.png')}" Addressable="true" />
  </Assets>
</PackageManifest>
`
}

module.exports = { buildManifest }
