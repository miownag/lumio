// TODO: Session types

export interface Session {
  id: string
  userId: string
  title: string
  mode: 'remote' | 'local'
  status: 'active' | 'paused' | 'completed' | 'error'
  createdAt: Date
  updatedAt: Date
}

export interface SessionEvent {
  id: number
  sessionId: string
  sequenceNum: number
  eventType: string
  payload: unknown
  createdAt: Date
}

export type SessionEventType =
  | 'user.message'
  | 'brain.thinking'
  | 'brain.tool_call'
  | 'hands.tool_result'
  | 'brain.message'
  | 'brain.context_reset'
  | 'session.snapshot'
  | 'session.error'
  | 'session.metadata'
