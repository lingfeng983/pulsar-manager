import React, { useEffect } from 'react'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useThemeStore } from './store/theme'
import Layout from './components/layout/Layout'

const App: React.FC = () => {
  const { theme } = useThemeStore()

  // 根据主题设置 Ant Design 暗色模式
  const isDark = theme === 'dark'

  useEffect(() => {
    // 设置 data-theme 属性以应用 CSS 变量
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
        token: {
          colorPrimary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
          borderRadius: 4,
        },
      }}
    >
      <Layout />
    </ConfigProvider>
  )
}

export default App
