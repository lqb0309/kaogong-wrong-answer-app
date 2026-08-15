import { create } from 'zustand'

interface SettingsState {
  config: Record<string, string>
  loaded: boolean
  load: () => Promise<void>
  set: (key: string, value: string) => Promise<void>
  get: (key: string, defaultValue?: string) => string
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: {},
  loaded: false,
  load: async () => {
    const config = await window.api.getAllConfig()
    set({ config, loaded: true })
  },
  set: async (key, value) => {
    await window.api.setConfig(key, value)
    set((s) => ({ config: { ...s.config, [key]: value } }))
  },
  get: (key, defaultValue = '') => {
    return get().config[key] || defaultValue
  }
}))
