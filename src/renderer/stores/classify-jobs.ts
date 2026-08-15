import { create } from 'zustand'

export interface ClassifyJob {
  traceId: string
  fileName: string
  stage: string
  message: string
  ts: number
}

interface ClassifyJobsState {
  jobs: Record<string, ClassifyJob>
  active: boolean
  setJob: (job: ClassifyJob) => void
  setActive: (v: boolean) => void
  clear: () => void
}

export const useClassifyJobsStore = create<ClassifyJobsState>((set) => ({
  jobs: {},
  active: false,
  setJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.traceId]: job } })),
  setActive: (v) => set({ active: v }),
  clear: () => set({ jobs: {}, active: false })
}))
