import { useEffect, useState } from 'react'
import { App, Button, Drawer, Form, Image, Input, InputNumber, Segmented, Select, Space, Typography } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { useTagTreeStore } from '@/stores/tag-tree'

export function NewQuestionDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (pendingReview: boolean) => void }) {
  const { message } = App.useApp()
  const { tree, loaded, load } = useTagTreeStore()
  const [form] = Form.useForm()
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [thumbnail, setThumbnail] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!loaded) load() }, [loaded, load])
  const l1 = Form.useWatch('level1', form), l2 = Form.useWatch('level2', form)
  const l1Options = tree.map(n => ({ value: n.name, label: n.name }))
  const l2Options = tree.find(n => n.name === l1)?.children.map(n => ({ value: n.name, label: n.name })) || []
  const l3Options = tree.find(n => n.name === l1)?.children.find((n: any) => n.name === l2)?.children.map((n: any) => ({ value: n.name, label: n.name })) || []
  const close = () => { form.resetFields(); setImagePath(null); setThumbnail(''); onClose() }
  const chooseImage = async () => {
    const paths = await window.api.selectFiles()
    if (!paths[0]) return
    setImagePath(paths[0]); setThumbnail(await window.api.readImageDataUrl(paths[0]))
  }
  const submit = async (values: any) => {
    setSaving(true)
    try {
      let imageUrl = ''
      if (imagePath) {
        const uploaded = await window.api.uploadImages([{ path: imagePath, rotation: 0 }])
        if (!uploaded[0]?.success) throw new Error(uploaded[0]?.error || '图片保存失败')
        imageUrl = uploaded[0].url
      }
      const result = await window.api.createManualQuestion({ ...values, imageUrl })
      if (!result.success) throw new Error(result.error || '保存失败')
      message.success(values.mode === 'review' ? '已加入待确认' : '已直接收入错题库')
      onCreated?.(Boolean(result.pendingReview)); close()
    } catch (error: any) { message.error(error.message) } finally { setSaving(false) }
  }
  return <Drawer title="新建错题" width={520} open={open} onClose={close} destroyOnClose
    extra={<Space><Button onClick={close}>取消</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Space>}>
    <Form form={form} layout="vertical" initialValues={{ errorCount: 1, mode: 'direct' }} onFinish={submit}>
      <Form.Item name="mode" label="保存方式"><Segmented block options={[{ value: 'direct', label: '直接收入错题库' }, { value: 'review', label: '先进入待确认' }]} /></Form.Item>
      <Typography.Text strong>题目内容</Typography.Text>
      <div onClick={chooseImage} style={{ margin: '10px 0 16px', minHeight: 110, border: '1px dashed #bfbfbf', borderRadius: 8, background: '#fafafa', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {thumbnail ? <Image src={thumbnail} preview={false} style={{ maxHeight: 180, objectFit: 'contain' }} /> : <Space direction="vertical" align="center"><InboxOutlined style={{ fontSize: 28, color: '#999' }} /><Typography.Text type="secondary">选择图片（可选）</Typography.Text></Space>}
      </div>
      <Form.Item name="ocrText" label="题目文字"><Input.TextArea rows={4} placeholder="没有图片时可以直接输入题目或摘要" /></Form.Item>
      <Typography.Text strong>分类与来源</Typography.Text>
      <Form.Item name="level1" label="一级分类" rules={[{ required: true, message: '请选择一级分类' }]}><Select options={l1Options} onChange={() => form.setFieldsValue({ level2: undefined, level3: undefined })} /></Form.Item>
      <Form.Item name="level2" label="二级分类"><Select options={l2Options} disabled={!l1} onChange={() => form.setFieldValue('level3', undefined)} /></Form.Item>
      <Form.Item name="level3" label="三级分类"><Select options={l3Options} disabled={!l2} allowClear /></Form.Item>
      <Space align="start" style={{ width: '100%' }}><Form.Item name="errorCount" label="错误次数"><InputNumber min={1} max={99} /></Form.Item><Form.Item name="source" label="题目来源" style={{ flex: 1 }}><Input placeholder="例如：2025 国考行测" /></Form.Item></Space>
    </Form>
  </Drawer>
}
