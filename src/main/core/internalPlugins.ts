import { app } from 'electron'
import path from 'path'

/**
 * 内置插件名称列表
 * 通过插件名称判断是否为内置插件，不需要额外的 internal 字段
 */
export const INTERNAL_PLUGIN_NAMES = ['setting', 'system'] as const

export type InternalPluginName = (typeof INTERNAL_PLUGIN_NAMES)[number]

/**
 * 判断是否为内置插件
 * @param pluginName 插件名称
 * @returns 是否为内置插件
 */
export function isInternalPlugin(pluginName: string): boolean {
  return INTERNAL_PLUGIN_NAMES.includes(pluginName as InternalPluginName)
}

/**
 * 获取内置插件路径
 * @param pluginName 插件名称
 * @returns 插件路径
 */
export function getInternalPluginPath(pluginName: InternalPluginName): string {
  const isDev = !app.isPackaged

  if (isDev) {
    // 开发环境：使用源码目录
    return path.resolve(process.cwd(), 'internal-plugins', pluginName)
  } else {
    // 生产环境：从 resources 加载
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'internal-plugins', pluginName)
  }
}
