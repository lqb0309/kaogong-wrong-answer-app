import { create } from 'zustand'

interface TreeNode {
  id: string
  name: string
  level: number
  children: TreeNode[]
}

interface TagTreeState {
  tree: TreeNode[]
  customTags: any[]
  loaded: boolean
  load: () => Promise<void>
  save: (tree: TreeNode[]) => Promise<void>
  addNode: (parentId: string, node: TreeNode) => Promise<void>
  editNode: (nodeId: string, name: string) => Promise<void>
  deleteNode: (nodeId: string) => Promise<void>
  addCustomTag: (tag: any) => Promise<void>
}

export const useTagTreeStore = create<TagTreeState>((set, get) => ({
  tree: [],
  customTags: [],
  loaded: false,
  load: async () => {
    const data = await window.api.getTagTree()
    const customTags = await window.api.getCustomTags()
    set({ tree: data?.tree || [], customTags: customTags || [], loaded: true })
  },
  save: async (tree) => {
    await window.api.saveTagTree({ tree })
    set({ tree })
  },
  addNode: async (parentId, node) => {
    const { tree } = get()
    let newTree: TreeNode[]
    if (!parentId) {
      // 添加一级分类
      newTree = [...tree, node]
    } else {
      const addToParent = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.id === parentId) {
            return { ...n, children: [...(n.children || []), node] }
          }
          return { ...n, children: addToParent(n.children || []) }
        })
      newTree = addToParent(tree)
    }
    await window.api.saveTagTree({ tree: newTree })
    set({ tree: newTree })
  },
  editNode: async (nodeId, name) => {
    const { tree } = get()
    const updateName = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => ({
        ...n,
        name: n.id === nodeId ? name : n.name,
        children: updateName(n.children || [])
      }))
    const newTree = updateName(tree)
    await window.api.saveTagTree({ tree: newTree })
    set({ tree: newTree })
  },
  deleteNode: async (nodeId) => {
    const { tree } = get()
    const removeNode = (nodes: TreeNode[]): TreeNode[] =>
      nodes.filter((n) => n.id !== nodeId).map((n) => ({
        ...n,
        children: removeNode(n.children || [])
      }))
    const newTree = removeNode(tree)
    await window.api.saveTagTree({ tree: newTree })
    set({ tree: newTree })
  },
  addCustomTag: async (tag) => {
    await window.api.addCustomTag(tag)
    set((s) => ({ customTags: [...s.customTags, tag] }))
  }
}))
