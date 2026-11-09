/* eslint-disable @typescript-eslint/no-var-requires */
// @ts-check
'use strict'

const path = require('path')
const FilterWarningsPlugin = require('webpack-filter-warnings-plugin')
const { TsconfigPathsPlugin } = require('tsconfig-paths-webpack-plugin')
const { createUnplugin } = require('unplugin')

// fast mode for local iteration: no source map, no type-check/declaration emit
// (type checking is done separately by `tsc --noEmit`)
const FAST = !!process.env.I18N_ALLY_FAST

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  optimization: {
    minimize: false,
  },
  entry: './src/extension.ts',
  output: {
    hashFunction: 'sha256',
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: FAST ? false : 'source-map',
  externals: {
    'vscode': 'commonjs vscode',
    'nodejieba': 'nodejieba',
    'esm': 'esm',
    'ts-node': 'ts-node',
    'consolidate': 'consolidate',
    'less': '_',
    'sass': '_',
    'stylus': '_',
    'prettier': 'prettier',
    '@microsoft/typescript-etw': '_',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    plugins: [
      new TsconfigPathsPlugin(),
    ],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: FAST
              ? { transpileOnly: true, onlyCompileBundledFiles: true }
              : {},
          },
        ],
      },
      {
        test: /\.mjs$/,
        include: /node_modules/,
        type: 'javascript/auto',
      },
    ],
  },
  plugins: [
    // @ts-ignore
    new FilterWarningsPlugin({
      exclude: /Critical dependency: the request of a dependency is an expression/,
    }),
    createUnplugin(() => {
      return {
        name: 'replace',
        enforce: 'pre',
        transform(code) {
          return code.replace(/process\.env\.NODE_ENV/g, JSON.stringify(process.env.I18N_ALLY_ENV))
        },
      }
    }).webpack(),
  ],
}

module.exports = config
