<h1 align="center">i18n CN</h1>

<p align="center"><i>VS Code 的 i18n 全能扩展 —— 基于正则的识别、可视化的语言映射，<br/>支持百度 / Google / DeepL 机器翻译。</i></p>

---

## 这是什么

**i18n CN** 是 [i18n-ally](https://github.com/lokalise/i18n-ally) 的一个持续维护分支，针对**文件名、结构都由自己定的语言文件**做了调整 —— 手写 JSON 词典、`chs.json` 这类自创命名、以中文为中心的工作流。

它是一个**独立扩展**（`jianghongxk.i18n-cn`），可以和原版同时安装、互不覆盖。命令 id、视图 id、配置项前缀仍然沿用 `i18n-ally.*` 命名空间，所以**现有项目的 `.vscode/settings.json` 一个字都不用改**。

## 主要能力

| | |
|---|---|
| **内联提示** — 在代码里直接看到每个 key 的译文 | **缺失文案报告** — 问题面板 + 按语言的翻译进度视图 |
| **正则提取** — 从代码里识别并提取硬编码文案，规则按框架配置 | **机器翻译** — 百度、Google、Google CN、DeepL、LibreTranslate、OpenAI |
| **语言文件白名单** — 显式声明哪些文件是语言文件，`commWord.json`、`iconfont.json` 这类同目录数据文件不会再被误当成译文 | **可视化映射** — 扫描本项目语言文件自动写入映射，或逐个语言手动绑定 |
| **语言文件增删** — 进度视图标题栏 `+` 新建、语言行垃圾桶删除 | **设置面板下拉** — 国家码与各引擎语言码都是枚举，不用背 |

内置框架：Vue、React（react-i18next / react-intl）、Angular（ngx-translate / transloco）、Svelte、Nuxt / next-translate、Laravel、Ember、Flutter、i18next、i18n-js、Polyglot、Globalize、Lingui、Fluent、UI5、php-gettext、php-joomla。这些框架全部由正则定义，自定义框架通常只需几行配置。

## 三步开始

1. **指定语言文件** — 设置 `i18n-ally.localesPaths`；更推荐跑一次 `逐个选取本项目的语言文件`，勾选后白名单会写进当前项目的 `.vscode/settings.json`。
2. **确定源语言** — `修改源语言` / `修改显示语言`，或直接改 `i18n-ally.sourceLanguage`。
3. **检查映射** — 跑 `翻译语言映射：诊断当前配置`。它会列出每个扫到的语言、能否翻译、不能的原因，并给出修法。没有映射时，`翻译语言映射：可视化配置本项目映射` 会扫描并写好。

侧边栏按语言显示翻译进度。标题栏的 `+` 是「从翻译引擎语言清单创建语言文件」；语言行上的垃圾桶删除该语言文件（进系统回收站，源语言不可删）。

## 与上游的差别

- **独立扩展 ID**，可与原版并存；输出面板与日志文件为 `i18n CN`。
- **`i18n-ally.localeFiles` 白名单**：一旦填写，只加载列出的文件，且这些文件跳过文件名形态校验 —— `chs.json`、`can.json` 乃至自己编的名字都认。
- **映射命令拆成三个单一动作**：可视化配置 / 手动绑定 / 诊断，点哪个就做哪件事，不再让你二次选择。
- **`localeCountryMap` 与 `translate.localeMap` 带 `enum` 和 `enumDescriptions`**，在设置面板里是下拉而非空白输入框。
- **自有图标与显示名**，与原版一眼可分。

> 关于 `translate.localeMap`：设置面板的 object 控件能给出值下拉，但**键**是动态的（取决于你项目里有哪些语言），无法预置枚举；「在 settings.json 中编辑」写的是**用户级**文件，容易把 A 项目的映射串到 B 项目。所以批量场景建议用上面的「可视化配置」，它只写当前项目。

## 致谢

这个扩展的存在完全建立在 [i18n-ally](https://github.com/lokalise/i18n-ally) 原作者与贡献者的工作上 —— 特别是 [@antfu](https://github.com/antfu) 与 [@think2011](https://github.com/think2011)（最初的 [vscode-vue-i18n](https://github.com/think2011/vscode-vue-i18n)），以及 vue-i18n 作者 [kazupon](https://github.com/kazupon) 的 [vue-i18n-locale-message](https://github.com/kazupon/vue-i18n-locale-message)（Vue SFC 支持）。上游贡献者名单见原仓库。

## 许可证

本分支采用 [MIT 许可](https://github.com/jianghongXk/i18n-ally/blob/main/LICENSE)。

- Copyright © 2021-present Lokalise 与 i18n-ally 贡献者（上游成果）
- Copyright © 2019-2020 [Anthony Fu](https://github.com/antfu)
- Copyright © 2018-2019 [think2011](https://github.com/think2011)
- 本分支的改动 © 2026 i18n CN

---

# English

## What this is

**i18n CN** is a maintained fork of [i18n-ally](https://github.com/lokalise/i18n-ally), tuned for
projects whose locale files are hand-rolled — arbitrary file names, plain-JSON dictionaries,
Chinese-first workflows.

It ships as its own extension (`jianghongxk.i18n-cn`), so it can sit **side by side** with the
official extension without either one overwriting the other. The command ids, view ids and setting
prefixes deliberately stay on the `i18n-ally.*` namespace, which means an existing
`.vscode/settings.json` keeps working untouched.

## Highlights

| | |
|---|---|
| **Inline annotations** — see the translation of any key in place, right in the editor | **Missing-key reporting** — problems panel + progress view per language |
| **Regex-based extraction** — detect and extract hard-coded strings, configurable per framework | **Machine translation** — Baidu, Google, Google CN, DeepL, LibreTranslate, OpenAI |
| **Explicit locale whitelist** — declare exactly which files are locales; sibling data files such as `commWord.json` are no longer mistaken for translations | **Visual locale mapping** — scan the project and write the engine mapping for you, or bind one language at a time |
| **Locale file management** — create and delete language files straight from the progress view | **Settings dropdowns** — country codes and engine language codes are enums, no need to memorise them |

Supported out of the box: Vue, React (react-i18next, react-intl), Angular (ngx-translate, transloco),
Svelte, Nuxt / next-translate, Laravel, Ember, Flutter, i18next, i18n-js, Polyglot, Globalize,
Lingui, Fluent, UI5, php-gettext, php-joomla — all defined as regular expressions, so a custom
framework is usually a few lines of config.

## Quick start

1. **Point the extension at your locale files** — `i18n-ally.localesPaths`, or run
   `i18n CN: Select locale files one by one` to pick them and write the whitelist into this
   project's `.vscode/settings.json`.
2. **Pick the source language** — `i18n CN: Set display language` / `Set source language`, or set
   `i18n-ally.sourceLanguage`.
3. **Check the mapping** — run `i18n CN: Diagnose locale mapping`. It lists every detected locale,
   whether a translation engine can handle it, and why not when it can't. If a locale has no
   mapping, `Configure locale mapping for this project` writes one for you.

The sidebar shows a progress view per language. `+` in the title bar creates a new locale file;
the trash icon on a language row deletes one (moved to the system trash, source language excluded).

## Differences from upstream

- Independent extension id — installable alongside the official extension.
- `i18n-ally.localeFiles` whitelist: once set, only the listed files load; loose name-shape
  validation is skipped for them, so `chs.json`, `can.json` or anything else you invented works.
- Three single-purpose mapping commands instead of one menu that asks again:
  configure / bind / diagnose.
- `localeCountryMap` and `translate.localeMap` carry `enum` + `enumDescriptions` in the settings
  UI, so those values are picked from a list rather than typed from memory.
- New icon and display name, so the two extensions are distinguishable at a glance.
