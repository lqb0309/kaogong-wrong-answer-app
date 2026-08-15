import { useEffect, useState } from 'react'
import { Typography, Card, Tree, Button, Space, Input, Modal, App, Row, Col, Tag as AntTag, List } from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  ImportOutlined, ExportOutlined, ReloadOutlined,
  StarOutlined
} from '@ant-design/icons'
import { useTagTreeStore } from '@/stores/tag-tree'
import { PageHeader } from '@/components/page-header'

interface TreeNode {
  id: string
  name: string
  level: number
  children: TreeNode[]
  source?: string
}

export function TagManagerPage() {
  const { tree, loaded, load, save, addNode, editNode, deleteNode, customTags } = useTagTreeStore()
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [editName, setEditName] = useState('')
  const [editingNode, setEditingNode] = useState<TreeNode | null>(null)
  const { message, modal } = App.useApp()

  // Error type management
  const [errorTypes, setErrorTypes] = useState<string[]>([])
  const [errorTypeModalOpen, setErrorTypeModalOpen] = useState(false)
  const [newErrorType, setNewErrorType] = useState('')
  const [editingErrorType, setEditingErrorType] = useState<string | null>(null)
  const [editErrorTypeValue, setEditErrorTypeValue] = useState('')

  useEffect(() => { if (!loaded) load() }, [loaded, load])

  useEffect(() => {
    window.api.getErrorTypes().then(setErrorTypes)
  }, [loaded])

  const selectedNode = findNode(tree, selectedKeys[0])

  const handleAdd = async () => {
    if (!newName.trim()) return
    const parentId = selectedKeys[0] || 'root'
    const parentNode = selectedNode
    const level = parentNode ? parentNode.level + 1 : 1
    const newNode: TreeNode = {
      id: `${parentId}-${Date.now()}`,
      name: newName.trim(),
      level: Math.min(level, 3),
      children: [],
      source: 'manual'
    }
    await addNode(parentId === 'root' ? '' : parentId, newNode)
    message.success(`已添加分类: ${newName}`)
    setNewName('')
    setAddModalOpen(false)
  }

  const handleEdit = async () => {
    if (!editName.trim() || !editingNode) return
    await editNode(editingNode.id, editName.trim())
    message.success(`已重命名为: ${editName}`)
    setEditName('')
    setEditingNode(null)
    setEditModalOpen(false)
  }

  const handleDelete = async () => {
    if (!selectedNode) return
    if (selectedNode.children?.length) {
      message.warning('该节点下有子分类，请先删除子分类')
      return
    }
    modal.confirm({
      title: `确认删除 "${selectedNode.name}"？`,
      content: '此操作不可恢复，关联的错题标签不受影响。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteNode(selectedNode.id)
        setSelectedKeys([])
        message.success('已删除')
      }
    })
  }

  const handleExport = async () => {
    const data = { version: '1.0', updated: new Date().toISOString().slice(0, 10), tree }
    const json = JSON.stringify(data, null, 2)
    await window.api.saveFile('分类树-export.json', json)
    message.success('分类树已导出')
  }

  const handleImport = async () => {
    const filePath = await window.api.selectFile()
    if (!filePath) return
    try {
      const text = await window.api.readFile(filePath)
      const data = JSON.parse(text)
      if (!data.tree || !Array.isArray(data.tree)) {
        message.error('JSON 格式不正确，需要包含 tree 字段')
        return
      }
      modal.confirm({
        title: '确认导入',
        content: `将用导入的分类树替换当前分类树，共 ${countNodes(data.tree)} 个节点。确认继续？`,
        okText: '导入',
        cancelText: '取消',
        onOk: async () => {
          await save(data.tree)
          message.success('分类树已导入')
        }
      })
    } catch {
      message.error('文件读取失败，请检查 JSON 格式')
    }
  }

  const handleAddErrorType = async () => {
    if (!newErrorType.trim()) return
    if (errorTypes.includes(newErrorType.trim())) {
      message.warning('该错误类型已存在')
      return
    }
    const updated = [...errorTypes, newErrorType.trim()]
    await window.api.saveErrorTypes(updated)
    setErrorTypes(updated)
    setNewErrorType('')
    setErrorTypeModalOpen(false)
    message.success(`已添加错误类型: ${newErrorType}`)
  }

  const handleEditErrorType = async () => {
    if (!editErrorTypeValue.trim() || !editingErrorType) return
    const updated = errorTypes.map(t => t === editingErrorType ? editErrorTypeValue.trim() : t)
    await window.api.saveErrorTypes(updated)
    setErrorTypes(updated)
    setEditingErrorType(null)
    setEditErrorTypeValue('')
    message.success('错误类型已更新')
  }

  const handleDeleteErrorType = async (type: string) => {
    const updated = errorTypes.filter(t => t !== type)
    await window.api.saveErrorTypes(updated)
    setErrorTypes(updated)
    message.success(`已删除错误类型: ${type}`)
  }

  // 拖拽排序（PRD：拖拽调整同层级节点顺序）
  const handleDrop = async (info: any) => {
    const dropKey = info.node.key as string
    const dragKey = info.dragNode.key as string
    if (dragKey === dropKey) return

    const dropPos = (info.node.pos as string).split('-')
    const dropPosition = info.dropPosition - Number(dropPos[dropPos.length - 1])

    // 深拷贝当前树
    const data = JSON.parse(JSON.stringify(tree)) as TreeNode[]
    const dragNode = findNode(data, dragKey)
    if (!dragNode) return

    // 移除被拖节点
    const removeLoop = (nodes: TreeNode[]): boolean => {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === dragKey) { nodes.splice(i, 1); return true }
        if (nodes[i].children?.length && removeLoop(nodes[i].children)) return true
      }
      return false
    }
    removeLoop(data)

    const dropNode = findNode(data, dropKey)
    if (!dropNode) return

    if (dropPosition === 0) {
      // 成为 dropNode 的子节点
      if (dropNode.level >= 3) {
        message.warning('分类层级最多 3 级，无法继续下移')
        return
      }
      dropNode.children = [...(dropNode.children || []), { ...dragNode, level: dropNode.level + 1 }]
    } else {
      // 插入到 dropNode 之前(-1)或之后(1)（同级）
      let inserted = false
      const insertLoop = (nodes: TreeNode[]): boolean => {
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i].id === dropKey) {
            const idx = dropPosition > 0 ? i + 1 : i
            nodes.splice(idx, 0, { ...dragNode, level: nodes[i].level })
            inserted = true
            return true
          }
          if (nodes[i].children?.length && insertLoop(nodes[i].children)) return true
        }
        return false
      }
      insertLoop(data)
      if (!inserted) return
    }

    await save(data)
    setSelectedKeys([])
    message.success('排序已更新')
  }

  const toTreeData = (nodes: TreeNode[]): any[] =>
    nodes.map((n) => ({
      key: n.id,
      title: (
        <span>
          {n.name}
          {n.source === 'ai' && (
            <AntTag color="green" style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px' }}>
              <StarOutlined /> AI
            </AntTag>
          )}
        </span>
      ),
      children: n.children?.length ? toTreeData(n.children) : undefined
    }))

  return (
    <div>
      <PageHeader
        title="标签管理"
        subtitle="维护三级分类树与错误类型，拖拽调整排序"
        extra={
          <Space>
            <Button icon={<ImportOutlined />} onClick={handleImport}>导入</Button>
            <Button icon={<ExportOutlined />} onClick={handleExport}>导出</Button>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          </Space>
        }
      />

      <Row gutter={16}>
        <Col span={14}>
          <Card title="分类树" size="small">
            <Tree
              treeData={toTreeData(tree)}
              selectedKeys={selectedKeys}
              onSelect={(keys) => setSelectedKeys(keys as string[])}
              defaultExpandAll
              blockNode
              draggable
              onDrop={handleDrop}
              style={{ minHeight: 400 }}
            />
          </Card>
        </Col>
        <Col span={10}>
          <Card title="操作" size="small">
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Button icon={<PlusOutlined />} block
                onClick={() => setAddModalOpen(true)}>
                添加子分类
              </Button>
              <Button icon={<EditOutlined />} block
                disabled={!selectedNode}
                onClick={() => {
                  if (!selectedNode) return
                  setEditingNode(selectedNode)
                  setEditName(selectedNode.name)
                  setEditModalOpen(true)
                }}>
                重命名
              </Button>
              <Button icon={<DeleteOutlined />} block danger
                disabled={!selectedNode}
                onClick={handleDelete}>
                删除
              </Button>
            </Space>

            {selectedNode && (
              <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 6 }}>
                <Typography.Text strong>选中节点</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  <AntTag>{selectedNode.name}</AntTag>
                  <AntTag>{`层级: ${selectedNode.level}`}</AntTag>
                  {selectedNode.children?.length > 0 && (
                    <AntTag>{`${selectedNode.children.length} 个子分类`}</AntTag>
                  )}
                </div>
              </div>
            )}

            {/* Custom tags */}
            {customTags.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Typography.Text strong>自定义标签库</Typography.Text>
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {customTags.map((t: any) => (
                    <AntTag key={t.id || t.name}>{t.name}</AntTag>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Error Type Management */}
      <Card title="错误类型管理" size="small" style={{ marginTop: 16 }}
        extra={<Button icon={<PlusOutlined />} size="small" onClick={() => setErrorTypeModalOpen(true)}>添加</Button>}>
        {errorTypes.length === 0 ? (
          <Typography.Text type="secondary">暂无自定义错误类型</Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={errorTypes}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button size="small" type="link" icon={<EditOutlined />}
                    onClick={() => { setEditingErrorType(item); setEditErrorTypeValue(item) }} />,
                  <Button size="small" type="link" danger icon={<DeleteOutlined />}
                    onClick={() => {
                      modal.confirm({
                        title: `确认删除错误类型"${item}"？`,
                        content: '已使用该类型的错题不受影响。',
                        okText: '确认删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => handleDeleteErrorType(item)
                      })
                    }} />
                ]}
              >
                <AntTag>{item}</AntTag>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* Add Error Type Modal */}
      <Modal
        title="添加错误类型"
        open={errorTypeModalOpen}
        onOk={handleAddErrorType}
        onCancel={() => { setErrorTypeModalOpen(false); setNewErrorType('') }}
        okText="添加"
        cancelText="取消"
      >
        <Input
          placeholder="输入错误类型名称，如：凭语感做题"
          value={newErrorType}
          onChange={(e) => setNewErrorType(e.target.value)}
          onPressEnter={handleAddErrorType}
        />
      </Modal>

      {/* Edit Error Type Modal */}
      <Modal
        title="编辑错误类型"
        open={!!editingErrorType}
        onOk={handleEditErrorType}
        onCancel={() => { setEditingErrorType(null); setEditErrorTypeValue('') }}
        okText="确认"
        cancelText="取消"
      >
        <Input
          placeholder="输入新的错误类型名称"
          value={editErrorTypeValue}
          onChange={(e) => setEditErrorTypeValue(e.target.value)}
          onPressEnter={handleEditErrorType}
        />
      </Modal>

      {/* Add Modal */}
      <Modal
        title={selectedNode ? `在 "${selectedNode.name}" 下添加子分类` : '添加一级分类'}
        open={addModalOpen}
        onOk={handleAdd}
        onCancel={() => { setAddModalOpen(false); setNewName('') }}
        okText="添加"
        cancelText="取消"
      >
        <Input
          placeholder="输入分类名称"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={handleAdd}
        />
      </Modal>

      {/* Edit Modal */}
      <Modal
        title="重命名分类"
        open={editModalOpen}
        onOk={handleEdit}
        onCancel={() => { setEditModalOpen(false); setEditName(''); setEditingNode(null) }}
        okText="确认"
        cancelText="取消"
      >
        <Input
          placeholder="输入新的分类名称"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onPressEnter={handleEdit}
        />
      </Modal>
    </div>
  )
}

function findNode(nodes: TreeNode[], id?: string): TreeNode | null {
  if (!id) return null
  for (const n of nodes) {
    if (n.id === id) return n
    const found = findNode(n.children || [], id)
    if (found) return found
  }
  return null
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children || []), 0)
}
