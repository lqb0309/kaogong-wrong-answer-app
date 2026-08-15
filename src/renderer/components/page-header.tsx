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
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 16,
      flexWrap: 'wrap',
      gap: 8
    }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>{title}</Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {subtitle}
          </Typography.Text>
        )}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  )
}
