import type { ReactNode } from 'react'
import { Typography, Space } from 'antd'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  extra?: ReactNode
}

/**
 * 统一页面头部：标题 + 可选说明 + 右侧操作区。
 * 所有页面共用，保证布局一致。
 */
export function PageHeader({ title, subtitle, extra }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-heading">
        <Typography.Title level={3} className="page-header-title">{title}</Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary" className="page-header-subtitle">
            {subtitle}
          </Typography.Text>
        )}
      </div>
      {extra && <Space wrap className="page-header-actions">{extra}</Space>}
    </header>
  )
}
