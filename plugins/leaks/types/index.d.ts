export type LeaksTab = 'findings' | 'timeline' | 'modes'

export type LeaksFilter = 'all' | 'private' | 'secret'

export type LeaksView = {
  tab: LeaksTab
  filter: LeaksFilter
  project: string | null
  confirmClear: boolean
  // Why the last change of a mode was refused
  notice: string | null
}

declare module 'claude-code' {
  interface PluginState {
    leaks: { view: LeaksView; rev: number }
  }
}
