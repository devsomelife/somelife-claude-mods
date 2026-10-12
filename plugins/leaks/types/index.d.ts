export type LeaksTab = 'findings' | 'timeline'

export type LeaksFilter = 'all' | 'private' | 'medical'

export type LeaksView = {
  tab: LeaksTab
  filter: LeaksFilter
  project: string | null
  confirmClear: boolean
}

declare module 'claude-code' {
  interface PluginState {
    leaks: { view: LeaksView; rev: number }
  }
}
