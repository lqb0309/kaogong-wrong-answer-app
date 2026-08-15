import { useEffect, useState, useCallback } from 'react'
import { Card, Form, Input, Select, Slider, InputNumber, Switch, Button, Divider, App, Alert, Collapse, Space } from 'antd'
import { useSettingsStore } from '@/stores/settings'
import { ReloadOutlined } from '@ant-design/icons'
import { PageHeader } from '@/components/page-header'

const { Panel } = Collapse

const defaultVisionModels: Record<string, string[]> = {
  qwen: ['qwen3-vl-plus', 'qwen3-vl-max', 'qwen-vl-max', 'qwen-vl-plus'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  custom: []
}

const defaultReasonModels: Record<string, string[]> = {
  deepseek: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'o4-mini'],
  qwen: ['qwen3-235b-a22b', 'qwen-max', 'qwen-plus', 'qwen-turbo'],
  custom: []
}

export function SettingsPage() {
  const { config, loaded, load, set } = useSettingsStore()
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const [visionOpts, setVisionOpts] = useState<{ value: string }[]>([])
  const [reasonOpts, setReasonOpts] = useState<{ value: string }[]>([])
  const [visionFetching, setVisionFetching] = useState(false)
  const [reasonFetching, setReasonFetching] = useState(false)

  useEffect(() => { if (!loaded) load() }, [loaded, load])

  useEffect(() => {
    if (!loaded || !Object.keys(config).length) return
    form.setFieldsValue({
      local_data_dir: config.local_data_dir || '',
      easyimage_url: config.easyimage_url || '',
      easyimage_token: config.easyimage_token || '',
      obsidian_vault: config.obsidian_vault || '',
      ai_pipeline_mode: config.ai_pipeline_mode || 'two_stage',
      vision_provider: config.vision_provider || 'qwen',
      vision_provider_name: config.vision_provider_name || '通义千问',
      vision_base_url: config.vision_base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      vision_api_key: config.vision_api_key || '',
      vision_model: config.vision_model || 'qwen3-vl-plus',
      ai_provider: config.ai_provider || 'deepseek',
      ai_provider_name: config.ai_provider_name || 'DeepSeek',
      ai_base_url: config.ai_base_url || 'https://api.deepseek.com',
      ai_api_key: config.ai_api_key || '',
      ai_model: config.ai_model || 'deepseek-v4-pro',
      image_compress_threshold: Number(config.image_compress_threshold || 500),
      image_compress_quality: Number(config.image_compress_quality || 0.7),
      confidence_threshold: Number(config.confidence_threshold || 0.7),
      weakness_threshold: Number(config.weakness_threshold || 5),
      fast_induct_error_count: Number(config.fast_induct_error_count || 1),
      upload_concurrency: Number(config.upload_concurrency || 5),
      classify_prompt: config.classify_prompt || '',
      log_level: config.log_level || 'WARN',
      log_retention: Number(config.log_retention || 30),
      error_notify: config.error_notify !== 'false'
    })
  }, [loaded, config, form])

  useEffect(() => {
    const vp = config.vision_provider || 'qwen'
    const rp = config.ai_provider || 'deepseek'
    setVisionOpts((defaultVisionModels[vp] || []).map(m => ({ value: m })))
    setReasonOpts((defaultReasonModels[rp] || []).map(m => ({ value: m })))
  }, [config.vision_provider, config.ai_provider])

  const handleSave = async (values: Record<string, any>) => {
    for (const [key, value] of Object.entries(values)) {
      await set(key, String(value ?? ''))
    }
    message.success('设置已保存')
  }

  const fetchVisionModels = useCallback(async () => {
    const url = form.getFieldValue('vision_base_url')
    const key = form.getFieldValue('vision_api_key')
    if (!url) return
    setVisionFetching(true)
    try {
      const res = await window.api.fetchModels(url, key || '')
      if (res.success && res.models?.length) {
        setVisionOpts(res.models.map(m => ({ value: m })))
        message.success(`获取 ${res.models.length} 个模型`)
      }
    } catch { }
    setVisionFetching(false)
  }, [form, message])

  const fetchReasonModels = useCallback(async () => {
    const url = form.getFieldValue('ai_base_url')
    const key = form.getFieldValue('ai_api_key')
    if (!url) return
    setReasonFetching(true)
    try {
      const res = await window.api.fetchModels(url, key || '')
      if (res.success && res.models?.length) {
        setReasonOpts(res.models.map(m => ({ value: m })))
        message.success(`获取 ${res.models.length} 个模型`)
      }
    } catch { }
    setReasonFetching(false)
  }, [form, message])

  const handleVisionProviderChange = (value: string) => {
    const urls: Record<string, string> = { qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', openai: 'https://api.openai.com', custom: form.getFieldValue('vision_base_url') || '' }
    form.setFieldValue('vision_base_url', urls[value] || '')
    const defaults = defaultVisionModels[value] || []
    form.setFieldValue('vision_model', defaults[0] || '')
    setVisionOpts(defaults.map(m => ({ value: m })))
  }

  const handleReasonProviderChange = (value: string) => {
    const urls: Record<string, string> = { deepseek: 'https://api.deepseek.com', openai: 'https://api.openai.com', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', custom: form.getFieldValue('ai_base_url') || '' }
    form.setFieldValue('ai_base_url', urls[value] || '')
    const defaults = defaultReasonModels[value] || []
    form.setFieldValue('ai_model', defaults[0] || '')
    setReasonOpts(defaults.map(m => ({ value: m })))
  }

  const handleTestEasyImage = useCallback(async () => {
    const url = form.getFieldValue('easyimage_url')
    const token = form.getFieldValue('easyimage_token')
    if (!url || !token) { message.warning('请填写地址和 Token'); return }
    const res = await window.api.testEasyImage(url, token)
    message[res.success ? 'success' : 'error'](res.success ? '连接正常' : res.error || '连接失败')
  }, [form, message])

  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="设置" subtitle="所有配置项均在 App 内修改，无需手改配置文件" />
      <Form form={form} layout="vertical" onFinish={handleSave}
        initialValues={{
          vision_provider: 'qwen', vision_provider_name: '通义千问', vision_model: 'qwen3-vl-plus', vision_base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          ai_provider: 'deepseek', ai_provider_name: 'DeepSeek', ai_model: 'deepseek-v4-pro', ai_base_url: 'https://api.deepseek.com',
          ai_pipeline_mode: 'two_stage',
          image_compress_threshold: 500, image_compress_quality: 0.7,
          confidence_threshold: 0.7, weakness_threshold: 5,
          fast_induct_error_count: 1, upload_concurrency: 5, classify_prompt: '',
          log_level: 'WARN', log_retention: 30, error_notify: true
        }}>

        <Collapse defaultActiveKey={['storage']} expandIconPosition="end" style={{ marginBottom: 16 }}>
          {/* ===== 存储 ===== */}
          <Panel header="存储" key="storage">
            <Form.Item label="本地数据目录" name="local_data_dir" tooltip="错题 Markdown 和图片的本地存储位置">
              <Input placeholder="~/考公错题（默认）" />
            </Form.Item>
          </Panel>

          {/* ===== 图床 ===== */}
          <Panel header="EasyImage 图床（可选）" key="easyimage">
            <Alert message="配置后图片URL使用图床地址，未配置则使用本地路径" type="info" showIcon style={{ marginBottom: 12 }} />
            <Form.Item label="地址" name="easyimage_url" rules={[{ type: 'url', message: '请输入有效 URL', warningOnly: true }]}>
              <Input placeholder="https://your-nas/easyimage" />
            </Form.Item>
            <Form.Item label="Token" name="easyimage_token">
              <Input.Password placeholder="API Token" />
            </Form.Item>
            <Button size="small" onClick={handleTestEasyImage}>测试连接</Button>
          </Panel>

          {/* ===== Obsidian ===== */}
          <Panel header="Obsidian Vault（可选）" key="obsidian">
            <Alert message="直接往 Vault 目录写 .md 文件，Obsidian 自动索引，无需插件" type="info" showIcon style={{ marginBottom: 12 }} />
            <Form.Item label="Vault 路径" name="obsidian_vault">
              <Input placeholder="/Users/deca/Obsidian/考公" />
            </Form.Item>
          </Panel>

          {/* ===== AI 流水线 ===== */}
          <Panel header="AI 分类模式" key="pipeline">
            <Form.Item name="ai_pipeline_mode" label="流水线">
              <Select options={[
                { value: 'vision_only', label: '仅视觉模型 — 看图直接出分类（1次调用）' },
                { value: 'two_stage', label: '两阶段 — 视觉看图 → 推理分类（2次调用，更准）' }
              ]} />
            </Form.Item>
            <Form.Item name="classify_prompt" label="AI 分类 Prompt（可选）"
              tooltip="留空使用内置 Prompt（自动注入分类树）。自定义后完全以此为准，请自行包含分类要求">
              <Input.TextArea rows={6} placeholder="自定义 System Prompt，留空使用默认（自动注入当前分类树）" />
            </Form.Item>
          </Panel>

          {/* ===== 视觉模型 ===== */}
          <Panel header="视觉模型" key="vision">
            <Alert message="识别图片文字和题目内容。需要多模态（支持图片输入）的模型" type="info" showIcon style={{ marginBottom: 12 }} />
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item label="预设" name="vision_provider" style={{ width: 180 }}>
                <Select options={[
                  { value: 'qwen', label: '通义千问' }, { value: 'openai', label: 'OpenAI' }, { value: 'custom', label: '自定义' }
                ]} onChange={handleVisionProviderChange} />
              </Form.Item>
              <Form.Item label="显示名称" name="vision_provider_name" style={{ width: 150 }}>
                <Input placeholder="自定义名称" />
              </Form.Item>
            </Space>
            <Form.Item label="Base URL" name="vision_base_url">
              <Input placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
            </Form.Item>
            <Form.Item label="API Key" name="vision_api_key">
              <Input.Password placeholder="sk-xxx" />
            </Form.Item>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="vision_model" noStyle>
                <Select placeholder="模型名称" options={visionOpts} showSearch
                  dropdownRender={(menu) => (
                    <>{menu}<Divider style={{ margin: '4px 0' }} /><Button type="link" icon={<ReloadOutlined spin={visionFetching} />} onClick={fetchVisionModels} style={{ width: '100%' }}>从 API 拉取</Button></>
                  )} />
              </Form.Item>
              <Button onClick={useCallback(async () => {
                const url = form.getFieldValue('vision_base_url'); const key = form.getFieldValue('vision_api_key')
                const model = form.getFieldValue('vision_model')
                if (!key || !model) { message.warning('请填写 Key 和模型'); return }
                const res = await window.api.testConnection(url, key, model)
                message[res.success ? 'success' : 'error'](res.success ? `连通 ${res.latency}ms` : res.error)
              }, [form, message])}>测试</Button>
            </Space.Compact>
          </Panel>

          {/* ===== 推理模型 ===== */}
          <Panel header="推理模型" key="reason">
            <Alert message="根据视觉识别结果做深度分类。文本模型即可，不需要多模态" type="info" showIcon style={{ marginBottom: 12 }} />
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item label="预设" name="ai_provider" style={{ width: 180 }}>
                <Select options={[
                  { value: 'deepseek', label: 'DeepSeek' }, { value: 'openai', label: 'OpenAI' }, { value: 'qwen', label: '通义千问' }, { value: 'custom', label: '自定义' }
                ]} onChange={handleReasonProviderChange} />
              </Form.Item>
              <Form.Item label="显示名称" name="ai_provider_name" style={{ width: 150 }}>
                <Input placeholder="自定义名称" />
              </Form.Item>
            </Space>
            <Form.Item label="Base URL" name="ai_base_url">
              <Input placeholder="https://api.deepseek.com" />
            </Form.Item>
            <Form.Item label="API Key" name="ai_api_key">
              <Input.Password placeholder="sk-xxx" />
            </Form.Item>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="ai_model" noStyle>
                <Select placeholder="模型名称" options={reasonOpts} showSearch
                  dropdownRender={(menu) => (
                    <>{menu}<Divider style={{ margin: '4px 0' }} /><Button type="link" icon={<ReloadOutlined spin={reasonFetching} />} onClick={fetchReasonModels} style={{ width: '100%' }}>从 API 拉取</Button></>
                  )} />
              </Form.Item>
              <Button onClick={useCallback(async () => {
                const url = form.getFieldValue('ai_base_url'); const key = form.getFieldValue('ai_api_key')
                const model = form.getFieldValue('ai_model')
                if (!key || !model) { message.warning('请填写 Key 和模型'); return }
                const res = await window.api.testConnection(url, key, model)
                message[res.success ? 'success' : 'error'](res.success ? `连通 ${res.latency}ms` : res.error)
              }, [form, message])}>测试</Button>
            </Space.Compact>
          </Panel>

          {/* ===== 图片 ===== */}
          <Panel header="图片处理" key="image">
            <Form.Item label="压缩阈值 (KB)" name="image_compress_threshold" tooltip="超过此大小触发压缩，0 禁用">
              <InputNumber min={0} max={20480} style={{ width: '100%' }} placeholder="500" />
            </Form.Item>
            <Form.Item label="压缩质量" name="image_compress_quality">
              <Slider min={0.1} max={1} step={0.05} marks={{ 0.1: '0.1', 0.3: '0.3', 0.5: '0.5', 0.7: '0.7', 0.9: '0.9', 1: '1' }} />
            </Form.Item>
          </Panel>

          {/* ===== 阈值 ===== */}
          <Panel header="分类阈值" key="threshold">
            <Form.Item label="置信度阈值" name="confidence_threshold" tooltip="低于此值确认界面高亮">
              <Slider min={0} max={1} step={0.05} marks={{ 0: '0', 0.25: '0.25', 0.5: '0.5', 0.75: '0.75', 1: '1' }} />
            </Form.Item>
            <Form.Item label="弱点提醒 (题数)" name="weakness_threshold" tooltip="某题型超过此数统计看板高亮">
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="快速入库默认错误次数" name="fast_induct_error_count" tooltip="「全部快速入库」时每道题默认的错误次数">
              <InputNumber min={1} max={10} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="上传并发数" name="upload_concurrency" tooltip="批量导入图片时同时处理的数量（1~8）">
              <InputNumber min={1} max={8} style={{ width: '100%' }} />
            </Form.Item>
          </Panel>

          {/* ===== 日志 ===== */}
          <Panel header="日志" key="log">
            <Form.Item label="日志级别" name="log_level">
              <Select options={['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].map(v => ({ value: v, label: v }))} />
            </Form.Item>
            <Form.Item label="保留天数" name="log_retention">
              <InputNumber min={1} max={365} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="错误通知" name="error_notify" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Panel>
        </Collapse>

        <Button type="primary" htmlType="submit" size="large" block>保存设置</Button>
      </Form>
    </div>
  )
}
