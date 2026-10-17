import { useCallback, useEffect, useState } from 'react'
import { Alert, App, AutoComplete, Button, Card, Col, Divider, Form, Input, InputNumber, Menu, Popconfirm, Row, Segmented, Select, Slider, Space, Statistic, Switch, Tag, Typography } from 'antd'
import { AppstoreOutlined, SlidersOutlined, ApiOutlined, CloudOutlined, ExperimentOutlined, FolderOpenOutlined, ReloadOutlined, SafetyCertificateOutlined, WalletOutlined } from '@/components/study-icons'
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
  review_daily_count: 5, log_level: 'WARN', log_retention: 30, auto_classify_after_import: false, error_notify: true,
  plan_memory_preferences: '在职备考；工作日约 90 分钟；一天只安排行测或申论其中一类完整套题；复盘优先，做题与复盘时间 1:1 至 1:1.5；补任务替换新任务，不叠加；状态不好时主动减量，不要求每天所有模块都练。'
}
const defaultReflectionPrompt = `请生成一份适合个人错题复习的精炼复盘，目标是让我下次遇到同类题时能识别、解出并避开原错误。

严格按以下 Markdown 结构输出：

## 考点与识别信号
- 一句话说明核心考点。
- 列出 2～3 个看到题目时应立即识别的关键词或结构信号。

## 标准解题路径
- 用 3～6 个步骤写出可靠解法，只保留必要推导。
- 如题目信息不足以得到唯一答案，明确指出缺失信息，不得补造答案。

## 考场最短路径
- 给出可靠的快速定位、排除或简算方法。
- 如果不存在稳定捷径，明确写“建议按标准步骤作答”，不要编造秒杀口诀。

## 易错复盘
- 如果题目中包含“你的答案”和“正确答案”，比较两个选项并指出具体误判点。
- 如果有人工标注错误类型，结合该类型进一步解释。
- 只有作答或题目信息不足时，才列出 1～2 个可能原因。

## 下次行动规则
用一条加粗句子给出可执行规则，格式为：**下次看到……，先……，再……。**

全文控制在 400～800 个中文字符。不要重复题干，不写空泛鼓励，不提供无依据的蒙题结论。`

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
  const [modelLoading, setModelLoading] = useState({ vision: false, reason: false })
  const [connectionLoading, setConnectionLoading] = useState({ vision: false, reason: false })

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
    if (!values.reflection_prompt?.trim()) values.reflection_prompt = defaultReflectionPrompt
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
    const baseURL = form.getFieldValue(`${prefix}_base_url`) || ''
    if (!baseURL.trim()) return message.warning('请先填写接口地址')
    setModelLoading(previous => ({ ...previous, [kind]: true }))
    try {
      const r = await window.api.fetchModels(baseURL, form.getFieldValue(`${prefix}_api_key`) || '')
      if (baseURL !== form.getFieldValue(`${prefix}_base_url`)) return
      if (r.success && r.models?.length) { kind === 'vision' ? setVisionModels(r.models) : setReasonModels(r.models); message.success(`已获取 ${r.models.length} 个模型，当前选择保持不变`) }
      else message.error(r.error || '获取失败，可直接填写模型名称')
    } catch { message.error('获取失败，请重试或直接填写模型名称') }
    finally { setModelLoading(previous => ({ ...previous, [kind]: false })) }
  }
  const testModel = async (kind: 'vision' | 'reason') => {
    const prefix = kind === 'vision' ? 'vision' : 'ai', key = form.getFieldValue(`${prefix}_api_key`), model = form.getFieldValue(`${prefix}_model`)
    if (!key || !model) return message.warning('请先填写 API Key 和模型')
    setConnectionLoading(previous => ({ ...previous, [kind]: true }))
    try {
      const r = await window.api.testConnection(form.getFieldValue(`${prefix}_base_url`), key, model)
      message[r.success ? 'success' : 'error'](r.success ? `连接正常 · ${r.latency}ms` : r.error || '连接失败')
    } catch { message.error('连接测试失败，请稍后重试') }
    finally { setConnectionLoading(previous => ({ ...previous, [kind]: false })) }
  }
  const modelCard = (kind: 'vision' | 'reason') => {
    const vision = kind === 'vision', prefix = vision ? 'vision' : 'ai', options = vision ? visionModels : reasonModels
    return <Card title={vision ? '视觉识别' : '推理分类'} extra={<Tag color={vision ? 'blue' : 'purple'}>{vision ? '读图' : '文本'}</Tag>}>
      <Paragraph type="secondary">{vision ? '读取图片和题目文字，需要支持图片输入。' : '负责分类、反思和学习建议。'}</Paragraph>
      <Row gutter={12}><Col span={12}><Form.Item name={`${prefix}_provider`} label="服务商"><Select onChange={v => providerChange(kind, v)} options={(vision ? ['qwen', 'openai', 'custom'] : ['deepseek', 'openai', 'qwen', 'custom']).map(value => ({ value, label: value === 'custom' ? '自定义' : value }))} /></Form.Item></Col><Col span={12}><Form.Item name={`${prefix}_provider_name`} label="显示名称"><Input /></Form.Item></Col></Row>
      <Form.Item name={`${prefix}_model`} label="模型" extra="可从清单选择，也可直接输入模型名称；拉取清单不会更改当前选择。"><AutoComplete options={options.map(value => ({ value }))} filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())} placeholder="选择或输入模型名称" /></Form.Item>
      <Form.Item name={`${prefix}_api_key`} label="API Key"><Input.Password placeholder="仅加密保存在本机" /></Form.Item>
      <Form.Item name={`${prefix}_base_url`} label="接口地址"><Input /></Form.Item>
      <Space><Button loading={connectionLoading[kind]} onClick={() => testModel(kind)}>测试连接</Button><Button loading={modelLoading[kind]} icon={<ReloadOutlined />} onClick={() => fetchModels(kind)}>拉取模型</Button></Space>
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
    if (section === 'learning') return <><Title level={4}>学习流程</Title><Card><Row gutter={24}><Col span={12}><Form.Item name="auto_classify_after_import" label="导入后自动分类" valuePropName="checked"><Switch /></Form.Item><Form.Item name="review_daily_count" label="每日复习卡片数"><InputNumber min={1} max={50} style={{ width: '100%' }} /></Form.Item><Form.Item name="weakness_threshold" label="弱点提醒题数"><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item></Col><Col span={12}><Form.Item name="confidence_threshold" label="低置信度提醒阈值"><Slider min={0} max={1} step={0.05} /></Form.Item><Form.Item name="fast_induct_error_count" label="快速入库默认错误次数"><InputNumber min={1} max={10} style={{ width: '100%' }} /></Form.Item><Form.Item name="upload_concurrency" label="批量处理并发数"><InputNumber min={1} max={8} style={{ width: '100%' }} /></Form.Item></Col></Row></Card><Card title="AI 计划记忆" style={{ marginTop: 12 }}><Paragraph type="secondary">这里保存长期有效的个人习惯；近 14 天完成率、未完成模块、错题和超时分布由程序自动滚动归纳，不需要手动维护。</Paragraph><Form.Item name="plan_memory_preferences" label="长期偏好与限制"><Input.TextArea rows={6} placeholder="例如：在职备考，工作日最多 90 分钟；资料分析每天必练……" /></Form.Item></Card></>
    if (section === 'backup') return <><Title level={4}>备份与恢复</Title><Alert type="success" showIcon message="每次启动自动备份，保留最近 14 份；恢复前会再保存当前数据。" style={{ marginBottom: 12 }} /><Card><Space><Button type="primary" icon={<SafetyCertificateOutlined />} loading={backupLoading} onClick={async () => { setBackupLoading(true); try { const r = await window.api.createBackup(); setBackups(await window.api.listBackups()); message.success(`已创建 ${r.backup.name}`) } finally { setBackupLoading(false) } }}>立即备份</Button>{backups[0] && <Button icon={<FolderOpenOutlined />} onClick={() => window.api.openExternal(backups[0].path)}>打开目录</Button>}</Space><Divider />{backups.slice(0, 10).map(item => <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0' }}><div><Text strong>{item.name}</Text><br /><Text type="secondary">{new Date(item.createdAt).toLocaleString()} · {(item.size / 1048576).toFixed(1)} MB</Text></div><Popconfirm title="恢复这份备份？" description="应用将自动重启" onConfirm={() => window.api.restoreBackup(item.name)}><Button danger size="small">恢复</Button></Popconfirm></div>)}</Card></>
    return <><Title level={4}>高级设置</Title><Card title="图片处理" style={{ marginBottom: 12 }}><Form.Item name="image_compress_threshold" label="压缩阈值（KB）"><InputNumber min={0} max={20480} /></Form.Item><Form.Item name="image_compress_quality" label="压缩质量"><Slider min={0.1} max={1} step={0.05} /></Form.Item></Card><Card title="分类 Prompt" style={{ marginBottom: 12 }}><Form.Item name="classify_prompt"><Input.TextArea rows={7} placeholder="留空使用内置 Prompt" /></Form.Item></Card><Card title="复盘 Prompt" style={{ marginBottom: 12 }} extra={<Button size="small" onClick={() => { form.setFieldValue('reflection_prompt', defaultReflectionPrompt); message.info('已恢复内置复盘 Prompt，保存本页后生效') }}>恢复默认</Button>}><Paragraph type="secondary">下方已显示当前使用的完整复盘提示词，可以直接修改。题目分类、OCR、你的答案、正确答案与错误类型会由程序自动附加，无需重复写入。</Paragraph><Form.Item name="reflection_prompt"><Input.TextArea rows={18} /></Form.Item></Card><Card title="诊断日志"><Row gutter={12}><Col span={12}><Form.Item name="log_level" label="日志级别"><Select options={['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].map(value => ({ value }))} /></Form.Item></Col><Col span={12}><Form.Item name="log_retention" label="保留天数"><InputNumber min={1} max={365} /></Form.Item></Col></Row><Form.Item name="error_notify" label="错误通知" valuePropName="checked"><Switch /></Form.Item></Card></>
  }

  const items = [{ key: 'overview', icon: <AppstoreOutlined />, label: '概览' }, { key: 'ai', icon: <ApiOutlined />, label: 'AI 模型' }, { key: 'billing', icon: <WalletOutlined />, label: '费用与余额' }, { key: 'storage', icon: <CloudOutlined />, label: '存储与同步' }, { key: 'learning', icon: <ExperimentOutlined />, label: '学习流程' }, { key: 'backup', icon: <SafetyCertificateOutlined />, label: '备份与恢复' }, { key: 'advanced', icon: <SlidersOutlined />, label: '高级设置' }]
  const showSave = !['overview', 'billing', 'backup'].includes(section)
  return <div className="settings-page">
    <PageHeader title="设置" subtitle="模型、学习习惯和数据管理，各自在这里调整" />
    <Form form={form} layout="vertical" className="settings-form">
      <div className="settings-grid">
        <aside className="settings-navigation" aria-label="设置分区">
          <Menu mode="inline" selectedKeys={[section]} items={items} onClick={({ key }) => setSection(key as Section)} />
          <div className="settings-navigation-hint">配置保存在本机<br />切换分区不会清空输入</div>
        </aside>
        <section className="settings-main">
          <div className="settings-panel" key={section}>{render()}</div>
          {showSave && <div className="settings-save-bar">
            <Text type="secondary">修改后保存，即可用于下一次处理</Text>
            <Button type="primary" loading={saving} onClick={save}>保存设置</Button>
          </div>}
        </section>
      </div>
    </Form>
  </div>
}
