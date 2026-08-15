import { Modal, Tree, Input } from 'antd'
import { useState, useEffect, useRef } from 'react'

interface TreeNode {
  id: string
  name: string
  level: number
  children: TreeNode[]
}

interface CategoryTreeSelectProps {
  open: boolean
  tree: TreeNode[]
  onOk: (selectedNode: TreeNode & { path?: string[] }) => void
  onCancel: () => void
}

export function CategoryTreeSelect({ open, tree, onOk, onCancel }: CategoryTreeSelectProps) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null)

  useEffect(() => {
    setSearch('')
    setSelected(null)
    setSelectedNode(null)
  }, [open])

  // id → 完整路径（如 ["判断推理", "图形推理"]），供确认页映射三级分类
  const pathMapRef = useRef<Record<string, string[]>>({})
  useEffect(() => {
    const map: Record<string, string[]> = {}
    const walk = (nodes: TreeNode[], parentPath: string[] = []) => {
      for (const n of nodes) {
        const path = [...parentPath, n.name]
        map[n.id] = path
        walk(n.children || [], path)
      }
    }
    walk(tree)
    pathMapRef.current = map
  }, [tree])

  const flattenTree = (nodes: TreeNode[], parentName = ''): { key: string; title: string; node: TreeNode }[] => {
    return nodes.flatMap((n) => {
      const path = parentName ? `${parentName} > ${n.name}` : n.name
      return [
        { key: n.id, title: path, node: n },
        ...flattenTree(n.children || [], path)
      ]
    })
  }

  const flatNodes = flattenTree(tree)
  const filtered = search
    ? flatNodes.filter((n) => n.title.toLowerCase().includes(search.toLowerCase()))
    : flatNodes

  return (
    <Modal
      title="选择分类"
      open={open}
      onOk={() => {
        if (!selectedNode) return
        onOk({ ...selectedNode, path: pathMapRef.current[selectedNode.id] || [selectedNode.name] })
      }}
      onCancel={onCancel}
      okButtonProps={{ disabled: !selectedNode }}
      width={480}
    >
      <Input.Search
        placeholder="搜索分类..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 16 }}
        allowClear
      />
      <div style={{ maxHeight: 400, overflow: 'auto' }}>
        {search ? (
          filtered.map((n) => (
            <div
              key={n.key}
              onClick={() => { setSelected(n.key); setSelectedNode(n.node) }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                background: selected === n.key ? '#e6f4ff' : 'transparent',
                borderRadius: 4,
                marginBottom: 4
              }}
            >
              {n.title}
            </div>
          ))
        ) : (
          <Tree
            treeData={tree.map(toTreeData)}
            onSelect={(keys, info) => {
              setSelected(keys[0] as string)
              setSelectedNode((info.node as any).data)
            }}
            selectedKeys={selected ? [selected] : []}
          />
        )}
        {filtered.length === 0 && <div style={{ textAlign: 'center', color: '#999', padding: 24 }}>无匹配结果</div>}
      </div>
    </Modal>
  )
}

function toTreeData(node: TreeNode): any {
  return {
    key: node.id,
    title: node.name,
    data: node,
    children: node.children?.map(toTreeData)
  }
}
