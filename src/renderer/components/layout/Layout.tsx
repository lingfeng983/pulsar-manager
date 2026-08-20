import React from 'react'
import TopNav from './TopNav'
import ResourceTree from './ResourceTree'
import TabWorkspace from './TabWorkspace'

const Layout: React.FC = () => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
      }}
    >
      {/* 顶部导航栏 */}
      <TopNav />

      {/* 主体区域 */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        }}
      >
        {/* 左侧资源树 */}
        <ResourceTree />

        {/* 中间 Tab 工作区 */}
        <TabWorkspace />
      </div>
    </div>
  )
}

export default Layout
