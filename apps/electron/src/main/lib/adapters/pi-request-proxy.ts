/**
 * 兼容旧入口；实现由 Pi provider 包维护。
 *
 * 必须转发到同一模块实例：该模块持有请求代理的 AsyncLocalStorage 作用域与
 * 全局 fetch 安装标记，两份副本会让 oauth-proxy-scope 设置的作用域失效。
 */
export * from '@profer/agent-provider-pi/pi/request-proxy'
