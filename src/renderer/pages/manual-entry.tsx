import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Card, Form, Select, Input, InputNumber, Button, App, Image, Space } from 'antd'
import { InboxOutlined, CheckOutlined } from '@ant-design/icons'
import { useTagTreeStore } from '@/stores/tag-tree'
import { PageHeader } from '@/components/page-header'

export function ManualEntryPage() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const { tree, loaded, load } = useTagTreeStore()
  const [form] = Form.useForm()
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [thumbnail, setThumbnail] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (!loaded) load() }, [loaded, load])

  const level1Options = tree.map((n) => ({ value: n.name, label: n.name }))
  const selectedL1 = Form.useWatch('level1', form)
  const level2Options = tree.find((n) => n.name === selectedL1)?.children.map((c) => ({ value: c.name, label: c.name })) || []
  const selectedL2 = Form.useWatch('level2', form)
  const level3Options = tree.find((n) => n.name === selectedL1)?.children.find((c: any) => c.name === selectedL2)?.children.map((c: any) => ({ value: c.name, label: c.name })) || []

  const handleSelectImage = async () => {
    const paths = await window.api.selectFiles()
    if (paths && paths.length > 0) {
      setImagePath(paths[0])
      window.api.readImageDataUrl(paths[0]).then(setThumbnail).catch(() => {})
    }
  }

  const handleSave = async (values: any) => {
    setSaving(true)
    try {
      // Handle image if selected
      let imageUrl = ''
      if (imagePath) {
        const results = await window.api.uploadImages([{ path: imagePath, rotation: 0 }])
        if (results[0]?.success) {
          imageUrl = results[0].url
        } else {
          message.error(`图片上传失败: ${results[0]?.error}`)
          setSaving(false)
          return
        }
      }

      const qId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const questionData = {
        id: qId,
        imageUrl,
        level1: values.level1 || '未分类',
        level2: values.level2 || '',
        level3: values.level3 || null,
        confidence: 1,
        ocrText: '',
        reasoning: '手动入库',
        errorCount: values.errorCount || 1,
        source: values.source || '',
        traceId: qId,
        status: 'confirmed'
      }

      const result = await window.api.writeToObsidian(questionData)
      if (result.success) {
        message.success('已手动入库')
        form.resetFields()
        setImagePath(null)
        setThumbnail('')
      }
    } catch (err: any) {
      message.error(`入库失败: ${err.message}`)
    }
    setSaving(false)
  }

  return (
    <div style={{ maxWidth: 600 }}>
      <PageHeader title="手动入库" subtitle="不经过 AI，手动填写分类信息直接入库" />

      <Form form={form} layout="vertical" onFinish={handleSave}
        initialValues={{ errorCount: 1 }}>

        <Card style={{ marginBottom: 16 }}>
          <Typography.Title level={5}>题目图片（可选）</Typography.Title>
          <div
            onClick={handleSelectImage}
            style={{
              border: '2px dashed #d9d9d9', borderRadius: 8, padding: 24, textAlign: 'center',
              cursor: 'pointer', background: '#fafafa', minHeight: 100,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
            }}
          >
            {thumbnail ? (
              <Image src={thumbnail} style={{ maxHeight: 200, objectFit: 'contain' }} preview={false} />
            ) : (
              <>
                <InboxOutlined style={{ fontSize: 32, color: '#bfbfbf' }} />
                <p style={{ marginTop: 8, color: '#999' }}>点击选择图片（可选）</p>
              </>
            )}
          </div>
          {imagePath && (
            <Button size="small" style={{ marginTop: 4 }} onClick={() => { setImagePath(null); setThumbnail('') }}>
              移除图片
            </Button>
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>分类标签</Typography.Title>
          <Form.Item label="一级分类" name="level1" rules={[{ required: true, message: '请选择' }]}>
            <Select options={level1Options} placeholder="选择一级分类" />
          </Form.Item>
          <Form.Item label="二级分类" name="level2">
            <Select options={level2Options} placeholder="选择二级分类" disabled={!selectedL1} />
          </Form.Item>
          <Form.Item label="三级分类" name="level3">
            <Select options={level3Options} placeholder="选择三级分类" disabled={!selectedL2} allowClear />
          </Form.Item>

          <Typography.Title level={5} style={{ marginTop: 24 }}>补充信息</Typography.Title>
          <Form.Item label="错误次数" name="errorCount">
            <InputNumber min={1} max={10} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="题目来源" name="source">
            <Input placeholder="如：2025国考行测真题" />
          </Form.Item>
        </Card>

        <Form.Item>
          <Button type="primary" htmlType="submit" size="large" loading={saving} icon={<CheckOutlined />}>
            手动入库
          </Button>
        </Form.Item>
      </Form>
    </div>
  )
}
