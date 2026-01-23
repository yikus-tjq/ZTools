import { session } from 'electron'

/**
 * 代理配置接口
 */
export interface ProxyConfig {
  enabled: boolean
  url: string
  proxyRules?: string
}

/**
 * 代理管理器
 * 统一管理所有 session 的代理配置
 */
class ProxyManager {
  private currentConfig: ProxyConfig = { enabled: false, url: '' }

  /**
   * 设置代理配置
   * @param config 代理配置
   */
  public setProxyConfig(config: { enabled: boolean; url: string }): void {
    this.currentConfig = {
      enabled: config.enabled,
      url: config.url,
      proxyRules: this.parseProxyRules(config.url)
    }
  }

  /**
   * 获取当前代理配置
   */
  public getProxyConfig(): ProxyConfig {
    return { ...this.currentConfig }
  }

  /**
   * 应用代理配置到指定 session
   * @param sess Electron session
   * @param name session 名称（用于日志）
   */
  public async applyProxyToSession(sess: Electron.Session, name?: string): Promise<void> {
    if (!this.currentConfig.enabled || !this.currentConfig.proxyRules) {
      // 清除代理
      await sess.setProxy({
        proxyRules: '',
        proxyBypassRules: ''
      })
      if (name) {
        console.log(`已清除 ${name} 的代理配置`)
      }
      return
    }

    // 应用代理
    // 绕过规则：使用 Chromium 的代理绕过规则语法
    // 参考：https://source.chromium.org/chromium/chromium/src/+/main:net/docs/proxy.md
    const bypassRules = [
      'localhost',      // 绕过 localhost
      '127.0.0.1',      // 绕过 127.0.0.1
      '::1',            // 绕过 IPv6 回环（不需要方括号）
      '<local>'         // 绕过所有本地地址
    ].join(',')         // 使用逗号分隔（不是分号）

    await sess.setProxy({
      proxyRules: this.currentConfig.proxyRules,
      proxyBypassRules: bypassRules
    })

    if (name) {
      console.log(`${name} 已应用代理配置: ${this.currentConfig.proxyRules}`)
      console.log(`绕过规则: ${bypassRules}`)
    }
  }

  /**
   * 应用代理配置到默认 session 并清理缓存
   */
  public async applyProxyToDefaultSession(): Promise<void> {
    // 清理 HTTP 缓存
    console.log('清理 HTTP 缓存...')
    await session.defaultSession.clearCache()
    console.log('HTTP 缓存已清理')

    // 应用代理
    await this.applyProxyToSession(session.defaultSession, '主程序')

    // 验证代理配置是否生效
    if (this.currentConfig.enabled && this.currentConfig.proxyRules) {
      // 测试外部地址（应该走代理）
      const externalProxy = await session.defaultSession.resolveProxy(
        'https://ztools-center.oss-cn-beijing.aliyuncs.com'
      )
      console.log('外部地址代理解析:', externalProxy)

      // 测试本地地址（应该不走代理）
      const localhostProxy = await session.defaultSession.resolveProxy('http://localhost:5174')
      console.log('localhost:5174 代理解析:', localhostProxy)

      const loopbackProxy = await session.defaultSession.resolveProxy('http://127.0.0.1:5174')
      console.log('127.0.0.1:5174 代理解析:', loopbackProxy)
    }
  }

  /**
   * 解析代理 URL 并转换为 Electron 的 proxyRules 格式
   * @param url 代理 URL
   * @returns proxyRules 字符串
   */
  private parseProxyRules(url: string): string {
    if (!url) return ''

    try {
      const proxyUrl = new URL(url)
      const protocol = proxyUrl.protocol.replace(':', '')
      const host = proxyUrl.hostname
      const port = proxyUrl.port || (protocol === 'https' ? '443' : '80')

      // 根据协议类型构建 proxyRules
      if (protocol === 'socks5' || protocol === 'socks4') {
        // SOCKS 代理格式：socks5://host:port
        return `${protocol}://${host}:${port}`
      } else if (protocol === 'http' || protocol === 'https') {
        // HTTP/HTTPS 代理格式：host:port（Electron 会自动处理）
        return `${host}:${port}`
      }

      // 其他情况返回原始 URL
      return url
    } catch (error) {
      console.warn('解析代理 URL 失败，使用原始格式:', error)
      return url
    }
  }
}

export default new ProxyManager()
