declare module 'electron' {
  export const app: {
    whenReady(): Promise<void>
    getPath(name: string): string
    quit(): void
    on(event: string, callback: (...args: any[]) => void): void
    requestSingleInstanceLock(): boolean
  }

  export const BrowserWindow: {
    new(options?: BrowserWindowOptions): BrowserWindowInstance
    getAllWindows(): BrowserWindowInstance[]
  }

  export interface BrowserWindowOptions {
    width?: number
    height?: number
    minWidth?: number
    minHeight?: number
    webPreferences?: WebPreferences
    titleBarStyle?: string
    frame?: boolean
    show?: boolean
  }

  export interface WebPreferences {
    preload?: string
    sandbox?: boolean
    contextIsolation?: boolean
    nodeIntegration?: boolean
  }

  export interface BrowserWindowInstance {
    loadURL(url: string): Promise<void>
    loadFile(path: string): Promise<void>
    show(): void
    close(): void
    reload(): void
    focus(): void
    restore(): void
    isMinimized(): boolean
    webContents: WebContents
    on(event: string, callback: (...args: any[]) => void): void
    once(event: string, callback: (...args: any[]) => void): void
  }

  export interface WebContents {
    openDevTools(): void
    setWindowOpenHandler(handler: (details: any) => { action: string }): void
    on(event: string, callback: (...args: any[]) => void): void
  }

  export const ipcMain: {
    handle(channel: string, callback: (event: IpcMainEvent, ...args: any[]) => Promise<any>): void
  }

  export interface IpcMainEvent {
    sender: IpcRenderer
  }

  export const contextBridge: {
    exposeInMainWorld(name: string, api: any): void
  }

  export const ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>
    on(channel: string, callback: (...args: any[]) => void): void
    removeListener(channel: string, callback: (...args: any[]) => void): void
  }

  export const shell: {
    openExternal(url: string): Promise<void>
  }
}
