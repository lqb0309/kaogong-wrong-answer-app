import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Col, Divider, Form, Input, InputNumber, Menu, Popconfirm, Row, Segmented, Select, Slider, Space, Statistic, Switch, Tag, Typography } from 'antd'
import { ApiOutlined, CloudOutlined, DatabaseOutlined, ExperimentOutlined, FolderOpenOutlined, ReloadOutlined, SafetyCertificateOutlined, SettingOutlined, WalletOutlined } from '@ant-design/icons'
import { useSettingsStore } from '@/stores/settings'
import { PageHeader } from '@/components/page-header'

const { Text, Title, Paragraph } = Typography
type Section = 'overview' | 'ai' | 'billing' | 'storage' | 'learning' | 'backup' | 'advanced'
type Billing = Awaited<ReturnType<typeof window.api.getBillingOverview>>
const models: Record<string, string[]> = {
  qwen: ['qwen3-vl-plus', 'qwen3-vl-max', 'qwen-max', 'qwen-plus'], deepseek: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'], custom: []
}
const defaults: Record<string, any> = {
  ai_pipeline_mode: 'two_stage', vision_provider: 'qwen', vision_provider_name: '通义千问', vision_base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', vision_model: 'qwen3-vl-plus',
  ai_provider: 'deepseek', ai_provider_name: 'DeepSeek', ai_base_url: 'https://api.deepseek.com', ai_model: 'deepseek-v4-pro', image_compress_threshold: 500,
  image_compress_quality: 0.7, confidence_threshold: 0.7, weakness_threshold: 5, fast_induct_error_count: 1, upload_concurrency: 5,
  review_daily_count: 5, log_level: 'WARN', log_retention: 30, auto_classify_after_import: false, error_notify: true
}

export function SettingsPage() {
  const { config, loaded, load, set } = useSettingsStore()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [section, setSection] = useState<Section>('overview')
  const [saving, setSaving] = useState(false)
  const [billing, setBilling] = useState<Billing | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  const [backups, setBackups] = useState<Array<{ name: string; path: string; createdAt: string; size: number }>>([])
  const [backupLoading, setBackupLoading] = useState(false)
  const [visionModels, setVisionModels] = useState(models.qwen)
  const [reasonModels, setReasonModels] = useState(models.deepseek)

  useEffect(() => { if (!loaded) load() }, [loaded, load])
  useEffect(() => { window.api.listBackups().then(setBackups).catch(() => setBackups([])) }, [])
  const refreshBilling = useCallback(async () => {
    setBillingLoading(true)
    try { setBilling(await window.api.getBillingOverview()) } catch { setBilling(null) } finally { setBillingLoading(false) }
  }, [])
  useEffect(() => { refreshBilling() }, [refreshBilling])
  useEffect(() => {
    if (!loaded) return
    const values = { ...defaults, ...config }
    ;['image_compress_threshold', 'image_compress_quality', 'confidence_threshold', 'weakness_threshold', 'fast_induct_error_count', 'upload_concurrency', 'review_daily_count', 'log_retention'].forEach(k => { values[k] = Number(values[k]) })
    ;['auto_classify_after_import', 'error_notify'].forEach(k => { values[k] = values[k] === true || values[k] === 'true' || (k === 'error_notify' && values[k] !== 'false') })
    form.setFieldsValue(values)
    setVisionModels(models[values.vision_provider] || [])
    setReasonModels(models[values.ai_provider] || [])
  }, [loaded, config, form])

  const save = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try { for (const [key, value] of Object.entries(values)) await set(key, String(value ?? '')); message.success('本页设置已保存'); refreshBilling() }
    finally { setSaving(false) }
  }
  const providerChange = (kind: 'vision' | 'reason', provider: string) => {
    const prefix = kind === 'vision' ? 'vision' : 'ai'
    const urls: Record<string, string> = { qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', openai: 'https://api.openai.com', deepseek: 'https://api.deepseek.com' }
    const options = models[provider] || []
    if (provider !== 'custom') form.setFieldValue(`${prefix}_base_url`, urls[provider])
    form.setFieldValue(`${prefix}_model`, options[0] || '')
    kind === 'vision' ? setVisionModels(options) : setReasonModels(options)
  }
  const fetchModels = async (kind: 'vision' | 'reason') => {
    const prefix = kind === 'vision' ? 'vision' : 'ai'
    const r = await window.api.fetchModels(form.getFieldValue(`${prefix}_base_url`), form.getFieldValue(`${prefix}_api_key`) || '')
    if (r.success && r.models?.length) { kind === 'vision' ? setVisionModels(r.models) : setReasonModels(r.models); message.success(`已获取 ${r.models.length} 个模型`) }
    else message.error(r.error || '获取失败')
  }
  const testModel = async (kind: 'vision' | 'reason') => {
    const prefix = kind === 'vision' ? 'vision' : 'ai', key = form.getFieldValue(`${prefix}_api_key`), model = form.getFieldValue(`${prefix}_model`)
    if (!key || !model) return message.warning('请先填写 API Key 和模型')
    const r = await window.api.testConnection(form.getFieldValue(`${prefix}_base_url`), key, model)
    message[r.success ? 'success' : 'error'](r.success ? `连接正常 · ${r.latency}ms` : r.error || '连接失败')
  }
  const modelCard = (kind: 'vision' | 'reason') => {
    const vision = kind === 'vision', prefix = vision ? 'vision' : 'ai', options = vision ? visionModels : reasonModels
    return <Card title={vision ? '视觉识别' : '推理分类'} extra={<Tag color={vision ? 'blue' : 'purple'}>{vision ? '读图' : '文本'}</Tag>}>
      <Paragraph type="secondary">{vision ? '读取图片和题目文字，需要支持图片输入。' : '负责分类、反思和学习建议。'}</Paragraph>
      <Row gutter={12}><Col span={12}><Form.Item name={`${prefix}_provider`} label="服务商"><Select onChange={v => providerChange(kind, v)} options={(vision ? ['qwen', 'openai', 'custom'] : ['deepseek', 'openai', 'qwen', 'custom']).map(value => ({ value, label: value === 'custom' ? '自定义' : value }))} /></Form.Item></Col><Col span={12}><Form.Item name={`${prefix}_provider_name`} label="显示名称"><Input /></Form.Item></Col></Row>
      <Form.Item name={`${prefix}_model`} label="模型"><Select showSearch options={options.map(value => ({ value }))} /></Form.Item>
      <Form.Item name={`${prefix}_api_key`} label="API Key"><Input.Password placeholder="仅加密保存在本机" /></Form.Item>
      <Form.Item name={`${prefix}_base_url`} label="接口地址"><Input /></Form.Item>
      <Space><Button onClick={() => testModel(kind)}>测试连接</Button><Button icon={<ReloadOutlined />} onClick={() => fetchModels(kind)}>拉取模型</Button></Space>
    </Card>
  }

  const render = () => {
    if (section === 'overview') return <><Title level={4}>设置概览</Title><Paragraph type="secondary">先看状态，再进入对应分区调整。</Paragraph><Row gutter={[12, 12]}>
      <Col xs={24} lg={8}><Card><Statistic title="视觉模型" value={config.vision_model || defaults.vision_model} /><Tag color={config.vision_api_key ? 'success' : 'warning'}>{config.vision_api_key ? '已配置' : '待配置'}</Tag></Card></Col>
      <Col xs={24} lg={8}><Card><Statistic title="推理模型" value={config.ai_model || defaults.ai_model} /><Tag color={config.ai_api_key ? 'success' : 'warning'}>{config.ai_api_key ? '已配置' : '待配置'}</Tag></Card></Col>
      <Col xs={24} lg={8}><Card><Statistic title="本月 AI 费用" prefix="$" precision={4} value={billing?.usage.month.cost || 0} /><Text type="secondary">本地调用估算</Text></Card></Col></Row>
      <Card title="常用操作" style={{ marginTop: 12 }}><Space wrap><Button type="primary" onClick={() => setSection('ai')}>配置 AI</Button><Button onClick={() => setSection('billing')}>查看费用</Button><Button onClick={() => setSection('backup')}>管理备份</Button></Space></Card></>
    if (section === 'ai') return <><Title level={4}>AI 模型</Title><Card style={{ marginBottom: 12 }}><Form.Item name="ai_pipeline_mode" label="处理方式"><Segmented block options={[{ value: 'vision_only', label: '快速：仅视觉' }, { value: 'two_stage', label: '准确：视觉 + 推理' }]} /></Form.Item><Text type="secondary">两阶段会多调用一次，但分类与反思通常更可靠。</Text></Card><Row gutter={[12, 12]}><Col xs={24} xl={12}>{modelCard('vision')}</Col><Col xs={24} xl={12}>{modelCard('reason')}</Col></Row></>
    if (section === 'billing') { const balance = billing?.balance.balances[0]; return <><Space style={{ width: '100%', justifyContent: 'space-between' }}><div><Title level={4}>费用与余额</Title><Paragraph type="secondary">费用来自本机调用记录，余额来自官方接口。</Paragraph></div><Button loading={billingLoading} icon={<ReloadOutlined />} onClick={refreshBilling}>刷新</Button></Space><Row gutter={[12, 12]}>
      <Col span={8}><Card><Statistic title="今日费用" prefix="$" precision={4} value={billing?.usage.today.cost || 0} /><Text type="secondary">{billing?.usage.today.calls || 0} 次调用</Text></Card></Col><Col span={8}><Card><Statistic title="本月费用" prefix="$" precision={4} value={billing?.usage.month.cost || 0} /><Text type="secondary">{billing?.usage.month.calls || 0} 次调用</Text></Card></Col><Col span={8}><Card><Statistic title="DeepSeek 余额" value={balance?.total || '--'} suffix={balance?.currency || ''} /><Text type="secondary">{billing?.balance.error || (billing?.balance.available ? '官方实时余额' : '暂不可用')}</Text></Card></Col></Row>
      <Card title="计费来源" style={{ marginTop: 12 }}><Space direction="vertical"><Space><Tag color={billing?.ccSwitch.detected ? 'success' : 'default'}>CC Switch {billing?.ccSwitch.detected ? '已连接' : '未发现'}</Tag><Text>{billing?.ccSwitch.detected ? `已加载 ${billing.ccSwitch.modelCount} 个模型价格` : '自动使用内置价格，未知价格不会影响调用'}</Text></Space><Text type="secondary">CC Switch 无需启动。本应用只读其价格库，不读取账号或密钥；显示费用为估算值。</Text></Space></Card></> }
    if (section === 'storage') return <><Title level={4}>存储与同步</Title><Card title="本地数据" style={{ marginBottom: 12 }}><Form.Item name="local_data_dir" label="错题与图片目录"><Input placeholder="留空使用默认目录" /></Form.Item></Card><Card title="EasyImage（可选）" style={{ marginBottom: 12 }}><Paragraph type="secondary">不配置时使用本地图片，不影响使用。</Paragraph><Form.Item name="easyimage_url" label="服务地址"><Input /></Form.Item><Form.Item name="easyimage_token" label="Token"><Input.Password /></Form.Item><Button onClick={async () => { const r = await window.api.testEasyImage(form.getFieldValue('easyimage_url'), form.getFieldValue('easyimage_token')); message[r.success ? 'success' : 'error'](r.success ? '连接正常' : r.error || '连接失败') }}>测试连接</Button></Card><Card title="Obsidian（可选）"><Form.Item name="obsidian_vault" label="Vault 路径"><Input placeholder="直接写 Markdown，无需插件" /></Form.Item></Card></>
    if (section === 'learning') return <><Title level={4}>学习流程</Title><Card><Row gutter={24}><Col span={12}><Form.Item name="auto_classify_after_import" label="导入后自动分类" valuePropName="checked"><Switch /></Form.Item><Form.Item name="review_daily_count" label="每日复习卡片数"><InputNumber min={1} max={50} style={{ width: '100%' }} /></Form.Item><Form.Item name="weakness_threshold" label="弱点提醒题数"><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item></Col><Col span={12}><Form.Item name="confidence_threshold" label="低置信度提醒阈值"><Slider min={0} max={1} step={0.05} /></Form.Item><Form.Item name="fast_induct_error_count" label="快速入库默认错误次数"><InputNumber min={1} max={10} style={{ width: '100%' }} /></Form.Item><Form.Item name="upload_concurrency" label="批量处理并发数"><InputNumber min={1} max={8} style={{ width: '100%' }} /></Form.Item></Col></Row></Card></>
    if (section === 'backup') return <><Title level={4}>备份与恢复</Title><Alert type="success" showIcon message="每次启动自动备份，保留最近 14 份；恢复前会再保存当前数据。" style={{ marginBottom: 12 }} /><Card><Space><Button type="primary" icon={<SafetyCertificateOutlined />} loading={backupLoading} onClick={async () => { setBackupLoading(true); try { const r = await window.api.createBackup(); setBackups(await window.api.listBackups()); message.success(`已创建 ${r.backup.name}`) } finally { setBackupLoading(false) } }}>立即备份</Button>{backups[0] && <Button icon={<FolderOpenOutlined />} onClick={() => window.api.openExternal(backups[0].path)}>打开目录</Button>}</Space><Divider />{backups.slice(0, 10).map(item => <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0' }}><div><Text strong>{item.name}</Text><br /><Text type="secondary">{new Date(item.createdAt).toLocaleString()} · {(item.size / 1048576).toFixed(1)} MB</Text></div><Popconfirm title="恢复这份备份？" description="应用将自动重启" onConfirm={() => window.api.restoreBackup(item.name)}><Button danger size="small">恢复</Button></Popconfirm></div>)}</Card></>
    return <><Title level={4}>高级设置</Title><Card title="图片处理" style={{ marginBottom: 12 }}><Form.Item name="image_compress_threshold" label="压缩阈值（KB）"><InputNumber min={0} max={20480} /></Form.Item><Form.Item name="image_compress_quality" label="压缩质量"><Slider min={0.1} max={1} step={0.05} /></Form.Item></Card><Card title="分类 Prompt" style={{ marginBottom: 12 }}><Form.Item name="classify_prompt"><Input.TextArea rows={7} placeholder="留空使用内置 Prompt" /></Form.Item></Card><Card title="诊断日志"><Row gutter={12}><Col span={12}><Form.Item name="log_level" label="日志级别"><Select options={['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].map(value => ({ value }))} /></Form.Item></Col><Col span={12}><Form.Item name="log_retention" label="保留天数"><InputNumber min={1} max={365} /></Form.Item></Col></Row><Form.Item name="error_notify" label="错误通知" valuePropName="checked"><Switch /></Form.Item></Card></>
  }

  const items = [{ key: 'overview', icon: <SettingOutlined />, label: '概览' }, { key: 'ai', icon: <ApiOutlined />, label: 'AI 模型' }, { key: 'billing', icon: <WalletOutlined />, label: '费用与余额' }, { key: 'storage', icon: <CloudOutlined />, label: '存储与同步' }, { key: 'learning', icon: <ExperimentOutlined />, label: '学习流程' }, { key: 'backup', icon: <DatabaseOutlined />, label: '备份与恢复' }, { key: 'advanced', icon: <SettingOutlined />, label: '高级设置' }]
  const showSave = !['overview', 'billing', 'backup'].includes(section)
  return <div style={{ maxWidth: 1120 }}><PageHeader title="设置" subtitle="按任务分区管理，关键状态一眼可见" /><Form form={form} layout="vertical"><Row gutter={20} align="top"><Col xs={24} md={6} lg={5}><Card styles={{ body: { padding: 8 } }} style={{ position: 'sticky', top: 16 }}><Menu mode="inline" selectedKeys={[section]} items={items} onClick={({ key }) => setSection(key as Section)} /></Card></Col><Col xs={24} md={18} lg={19}><div style={{ minHeight: 540 }}>{render()}</div>{showSave && <Card style={{ marginTop: 16 }} styles={{ body: { display: 'flex', justifyContent: 'flex-end' } }}><Button type="primary" size="large" loading={saving} onClick={save}>保存本页设置</Button></Card>}</Col></Row></Form></div>
}
