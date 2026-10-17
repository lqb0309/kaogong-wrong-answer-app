const tauri = (window as any).__TAURI__
const subscriptions = new Map<string, Map<Function, Promise<() => void>>>()
export const contextBridge = { exposeInMainWorld(name: string, value: unknown) { (window as any)[name] = value } }
export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]) {
    await Promise.all([...subscriptions.values()].flatMap(group => [...group.values()]))
    return tauri.core.invoke('service_call', { channel, args })
  },
  on(channel: string, listener: Function) {
    let group = subscriptions.get(channel)
    if (!group) { group = new Map(); subscriptions.set(channel, group) }
    if (!group.has(listener)) group.set(listener, tauri.event.listen('business-event', (event: any) => {
      if (event.payload.channel === channel) listener({}, event.payload.data)
    }))
  },
  removeListener(channel: string, listener: Function) {
    const group = subscriptions.get(channel), pending = group?.get(listener)
    group?.delete(listener); pending?.then(off => off())
  }
}
