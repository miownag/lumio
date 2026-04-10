// TODO: Sandbox types

export interface SandboxConfig {
  language?: string
  timeout?: number
}

export interface SandboxInfo {
  id: string
  status: 'creating' | 'ready' | 'running' | 'stopped'
}

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
}
