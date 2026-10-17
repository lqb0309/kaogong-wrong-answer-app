import type { ThemeConfig } from 'antd'

/** Shared desktop design tokens. Keep CSS variables in index.css in sync. */
export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#315cc6',
    colorInfo: '#315cc6',
    colorSuccess: '#218565',
    colorWarning: '#bd7418',
    colorError: '#c44444',
    colorText: '#25334a',
    colorTextSecondary: '#64748b',
    colorTextTertiary: '#758398',
    colorBorder: '#dfe6ef',
    colorBorderSecondary: '#e8edf4',
    colorBgLayout: '#f3f6fa',
    fontFamily: "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif",
    fontSize: 14,
    lineHeight: 1.65,
    borderRadius: 7,
    controlHeight: 34,
    controlHeightSM: 28,
    controlHeightLG: 40
  },
  components: {
    Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
    Card: { borderRadiusLG: 10, headerFontSize: 15, headerFontSizeSM: 14, headerHeightSM: 44, paddingLG: 20 },
    Menu: { itemBorderRadius: 7, itemMarginInline: 10, itemHeight: 40, itemSelectedBg: '#e8effc', itemSelectedColor: '#315cc6', groupTitleFontSize: 11 },
    Layout: { headerBg: '#ffffff', siderBg: '#f8fafd', triggerBg: '#f8fafd', triggerHeight: 40 },
    Table: { headerBg: '#f6f8fb', headerColor: '#4a5b74', cellPaddingBlockSM: 10, cellPaddingInlineSM: 12, borderColor: '#e8edf4' },
    Modal: { titleFontSize: 18 },
    Tabs: { titleFontSize: 14 },
    Typography: { titleMarginTop: 0, titleMarginBottom: 12 }
  }
}
