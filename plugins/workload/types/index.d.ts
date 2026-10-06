export type WorkloadRange = 'day' | 'week' | 'month'

export type WorkloadMetric = 'time' | 'tokens' | 'turns' | 'tools'

export type WorkloadView = {
  range: WorkloadRange
  offset: number
  metric: WorkloadMetric
  project: string | null
}

declare module 'claude-code' {
  interface PluginState {
    workload: { view: WorkloadView; rev: number }
  }
}
