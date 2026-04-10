Lumio - Super Agent Harness

# 全栈 Agent Harness 技术方案

> **设计哲学：Decouple Everything** — 沿用 Anthropic Managed Agents 的核心思想，将 **Brain（大脑/LLM调度）**、**Hands（执行沙箱/工具）**、**Session（会话事件流）** 三者彻底解耦，每个组件可独立失败、替换、扩展。
> 

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                   │
│  ┌──────────────────────┐     ┌──────────────────────────────────────┐  │
│  │   Web (Next.js)      │     │   Electron (Next.js + Node Bridge)  │  │
│  │   ─ 远程模式         │     │   ─ 远程模式 (同 Web)                │  │
│  │   ─ 只读本地会话     │     │   ─ 本地模式 (操作本地资源)          │  │
│  └──────────┬───────────┘     └─────────┬──────────┬─────────────────┘  │
│             │                           │          │                    │
│             │ HTTPS/WSS                 │          │ IPC (本地Agent)    │
└─────────────┼───────────────────────────┼──────────┼────────────────────┘
              │                           │          │
              ▼                           ▼          ▼
┌─────────────────────────────────────┐  ┌────────────────────────┐
│       Cloud Platform (Remote)       │  │  Local Agent Runtime   │
│  ┌─────────────────────────────┐    │  │  (Electron Main Proc)  │
│  │  API Gateway (Hono + Bun)   │    │  │  ┌──────────────────┐  │
│  │  ─ Better Auth 鉴权         │    │  │  │ Local Brain      │  │
│  │  ─ Rate Limiting            │    │  │  │ (Mastra Agent)   │  │
│  │  ─ WebSocket Upgrade        │    │  │  ├──────────────────┤  │
│  ├─────────────────────────────┤    │  │  │ Local Hands      │  │
│  │  Brain Service              │    │  │  │ (fs/shell/app)   │  │
│  │  ─ Agent Harness (Mastra)   │    │  │  ├──────────────────┤  │
│  │  ─ Context Management       │    │  │  │ Local Session    │  │
│  │  ─ Tool Router              │    │  │  │ (SQLite)         │  │
│  ├─────────────────────────────┤    │  │  └──────────────────┘  │
│  │  Hands Service              │    │  └────────────────────────┘
│  │  ─ Sandbox Pool (E2B/Docker)│    │
│  │  ─ MCP Tool Server          │    │
│  │  ─ File Storage (S3/Minio)  │    │
│  ├─────────────────────────────┤    │
│  │  Session Service            │    │
│  │  ─ Append-only Event Log    │    │
│  │  ─ PostgreSQL               │    │
│  │  ─ Event Stream (SSE/WS)    │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

---

## 二、核心设计原则（对齐 Anthropic Managed Agents）

### 2.1 三层解耦模型

| 组件 | 职责 | 接口约定 | 可替换性 |
| --- | --- | --- | --- |
| **Brain** | LLM 调用循环、工具路由、上下文管理、context reset | 接收 Session 事件流，输出 tool_call/message | 可替换不同 Agent 框架或模型 |
| **Hands** | 代码执行沙箱、文件操作、外部 API 调用、MCP 工具 | 接收 tool_call，返回 tool_result | 可替换 E2B / Docker / 本地 shell |
| **Session** | Append-only 事件日志（所有交互的真实来源） | 写入事件、读取事件流、快照 | 可替换存储后端 |

### 2.2 关键设计决策

- **Session 是 Source of Truth**：所有 Brain 和 Hands 的交互都通过 Session 事件流，Brain 挂掉后可以从 Session 恢复
- **Cattle, not Pets**：任何 Brain/Hands 实例都是无状态可替换的，状态全部在 Session 中
- **接口固定，实现可变**：对接口的 schema 有严格约定，但接口背后的实现可以自由替换

---

## 三、技术选型与论证

### 3.1 Agent 框架：**Mastra**（替代 LangGraph.js）

经过调研，**推荐使用 Mastra 替代 LangGraph.js**，理由如下：

| 维度 | Mastra | LangGraph.js |
| --- | --- | --- |
| **HTTP Server** | 原生基于 Hono（与你的后端技术栈天然匹配） | 需要自行封装 |
| **Server Adapter** | 内置 `@mastra/hono` 适配器，一行代码挂载 | 无 |
| **TypeScript** | TypeScript-first，类型安全 | TypeScript 支持但偏 Python 移植 |
| **部署** | `mastra build` 直接生成 Hono 服务，Docker 友好 | 需要自建 Docker 镜像 |
| **Memory** | 内置长短期记忆，支持 PostgreSQL 后端 | 依赖 LangChain 生态 |
| **Workflow** | 声明式 workflow，JS 开发者友好 | 图结构 workflow，学习曲线较陡 |
| **本地开发** | 内置 Dev Playground + Tracing | 无内置 Tracing |
| **MCP 支持** | 原生支持 MCP Server 暴露 | 需要额外集成 |
| **社区** | Gatsby 团队出品，PayPal/Replit 生产使用 | LangChain 生态 |

> **结论**：Mastra 与 Hono + Bun 的技术栈完美匹配，且其 Server Adapter 设计天然适合我们的解耦架构。
> 

### 3.2 沙箱方案：**分层沙箱策略**

| 场景 | 方案 | 隔离级别 |
| --- | --- | --- |
| **云端代码执行** | E2B (Firecracker microVM) | 硬件级隔离，独立内核 |
| **自托管/开发** | Docker-in-Docker (Sysbox) | 容器级隔离 |
| **本地模式** | Electron + 受限 shell | 进程级隔离 + 权限白名单 |

```
Sandbox Interface (统一抽象)
├── E2BSandboxProvider      (云端生产)
├── DockerSandboxProvider   (自托管)
└── LocalSandboxProvider    (Electron本地)
```

### 3.3 完整技术栈

| 层级 | 技术 | 说明 |
| --- | --- | --- |
| **前端框架** | Next.js 15 (App Router) | Web + Electron 共享代码 |
| **UI 组件** | shadcn/ui + Tailwind CSS v4 | 可复用组件库 |
| **状态管理** | Zustand + Zustand Middleware | 含 persist middleware 做离线缓存 |
| **Electron** | Electron + electron-builder | 桌面客户端壳 |
| **后端框架** | Hono.js on Bun | 轻量高性能 |
| **Agent 框架** | Mastra (with @mastra/hono) | Agent + Workflow + Memory |
| **数据库** | PostgreSQL 16 | Session/用户/Agent配置 |
| **缓存** | Redis (Valkey) | WebSocket pub/sub、速率限制 |
| **对象存储** | MinIO (S3 兼容) | 沙箱文件、附件 |
| **鉴权** | Better Auth | GitHub/Google/Apple OAuth |
| **沙箱** | E2B / Docker | 代码执行隔离 |
| **部署** | Docker Compose / K8s | 容器编排 |

---

## 四、模块详细设计

### 4.1 Session Service（会话服务）

```
Session = Append-only Event Log

事件类型:
├── user.message          # 用户发送消息
├── brain.thinking        # LLM 推理中（streaming）
├── brain.tool_call       # LLM 请求调用工具
├── hands.tool_result     # 工具执行结果
├── brain.message         # LLM 最终回复
├── brain.context_reset   # 上下文重置（长任务）
├── session.snapshot      # 状态快照点
├── session.error         # 错误事件
└── session.metadata      # 元数据更新
```

**数据模型（PostgreSQL）：**

```
sessions
├── id (uuid, PK)
├── user_id (uuid, FK)
├── title (text)
├── mode (enum: 'remote' | 'local')
├── status (enum: 'active' | 'paused' | 'completed' | 'error')
├── created_at (timestamptz)
└── updated_at (timestamptz)

session_events
├── id (bigserial, PK)
├── session_id (uuid, FK, indexed)
├── sequence_num (bigint, monotonic)
├── event_type (text, indexed)
├── payload (jsonb)
├── created_at (timestamptz)
└── INDEX (session_id, sequence_num)  -- 高效范围查询
```

**关键接口：**

- `POST /sessions` — 创建会话
- `GET /sessions/:id/events?after=seq_num` — 拉取事件（支持长轮询）
- `WS /sessions/:id/stream` — 实时事件流（WebSocket）
- `POST /sessions/:id/events` — 追加事件

### 4.2 Brain Service（大脑服务）

```tsx
// Mastra Agent 定义（概念示意）
const agent = new Agent({
  name: "harness-agent",
  model: anthropic("claude-sonnet-4-20250514"),  // 可切换模型
  instructions: dynamicSystemPrompt,      // 动态系统提示
  tools: {                                // 工具路由到 Hands
    execute_code: sandboxTool,
    read_file: fileTool,
    write_file: fileTool,
    shell_command: shellTool,
    web_search: searchTool,
    mcp_tool: mcpBridgeTool,
  },
  memory: {
    provider: "postgres",
    shortTerm: true,        // 对话内记忆
    longTerm: true,         // 跨对话记忆
  },
});
```

**Harness Loop（核心循环）：**

```
┌─────────────────────────────────────────┐
│            Brain Harness Loop           │
│                                         │
│  1. 从 Session 读取最新事件             │
│  2. 构建/裁剪 Context Window            │
│  3. 调用 LLM（streaming）               │
│  4. 如果是 tool_call:                   │
│     ├── 写入 brain.tool_call 到 Session │
│     ├── 发送给 Hands Service            │
│     ├── 等待 hands.tool_result          │
│     └── 回到 Step 2                     │
│  5. 如果是 message:                     │
│     ├── 写入 brain.message 到 Session   │
│     └── 结束本轮                        │
│  6. Context 接近限制:                   │
│     ├── 生成 summary                    │
│     ├── 写入 brain.context_reset        │
│     └── 回到 Step 2                     │
│                                         │
│  ※ 任何步骤失败可从 Session 恢复        │
└─────────────────────────────────────────┘
```

### 4.3 Hands Service（执行服务）

**统一沙箱接口：**

```tsx
interface SandboxProvider {
  // 生命周期
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;

  // 执行
  executeCode(sandboxId: string, code: string, language: string): Promise<ExecutionResult>;
  executeShell(sandboxId: string, command: string): Promise<ShellResult>;

  // 文件系统
  readFile(sandboxId: string, path: string): Promise<FileContent>;
  writeFile(sandboxId: string, path: string, content: Buffer): Promise<void>;
  listFiles(sandboxId: string, path: string): Promise<FileEntry[]>;

  // 网络
  exposePort(sandboxId: string, port: number): Promise<string>; // 返回 URL
}
```

**沙箱池管理：**

- 预热池：提前创建 N 个 warm sandbox，减少冷启动
- 超时回收：无活动 30 分钟自动回收
- 快照恢复：支持从快照恢复沙箱状态

### 4.4 鉴权模块（Better Auth）

```tsx
// better-auth 配置（概念示意）
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  database: postgres(pool),

  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
    apple: {
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET,
    },
  },

  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 天
  },
});

// Hono 集成
app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));

// 中间件
app.use("/api/*", authMiddleware(auth));
```

---

## 五、前端架构设计

### 5.1 代码共享策略

```
packages/
├── ui/                    # 共享 UI 组件 (shadcn + tailwind)
│   ├── components/
│   ├── hooks/
│   └── lib/
├── shared/                # 共享逻辑
│   ├── types/             # TypeScript 类型定义
│   ├── stores/            # Zustand stores
│   ├── api/               # API client
│   └── utils/
apps/
├── web/                   # Next.js Web App
│   ├── app/               # App Router pages
│   └── next.config.ts
├── desktop/               # Electron App
│   ├── main/              # Electron Main Process
│   │   ├── local-agent/   # 本地 Agent 运行时
│   │   ├── ipc-handlers/  # IPC 处理器
│   │   └── sandbox/       # 本地沙箱（受限 shell）
│   ├── renderer/          # 复用 Next.js（通过 next export）
│   └── preload/           # Preload 脚本
└── server/                # Hono + Bun 后端
    ├── src/
    │   ├── routes/
    │   ├── services/
    │   ├── agents/        # Mastra Agent 定义
    │   └── middleware/
    └── Dockerfile
```

### 5.2 Zustand Store 设计

```tsx
// 会话 Store
interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  mode: 'remote' | 'local';        // 当前模式

  // Actions
  createSession: (mode: 'remote' | 'local') => Promise<Session>;
  switchMode: (mode: 'remote' | 'local') => void;
  sendMessage: (content: string) => Promise<void>;

  // Streaming
  eventStream: SessionEvent[];
  isStreaming: boolean;
  subscribeToSession: (sessionId: string) => () => void;
}

// 鉴权 Store
interface AuthStore {
  user: User | null;
  isAuthenticated: boolean;
  login: (provider: 'github' | 'google' | 'apple') => Promise<void>;
  logout: () => Promise<void>;
}

// 沙箱 Store
interface SandboxStore {
  activeSandbox: SandboxInfo | null;
  files: FileTree;
  terminal: TerminalSession;
}
```

### 5.3 远程/本地模式切换（Electron）

```
┌─────────────────────────────────────────────┐
│           Electron Renderer                  │
│                                              │
│  ┌─── Mode Switch Toggle ───┐               │
│  │  [🌐 Remote]  [💻 Local] │               │
│  └───────────────────────────┘               │
│                                              │
│  mode === 'remote' ?                         │
│    → API calls → Cloud Server (同 Web)       │
│    → WebSocket → Cloud Event Stream          │
│                                              │
│  mode === 'local' ?                          │
│    → IPC calls → Electron Main Process       │
│    → Local Agent Runtime                     │
│    → 直接操作本地文件系统/应用               │
│                                              │
└─────────────────────────────────────────────┘
```

**本地模式能力：**

- 读写本地文件系统（用户授权的目录）
- 执行本地 shell 命令（白名单机制）
- 打开/操作本地应用（通过 AppleScript/PowerShell）
- 本地代码执行（受限 Node.js 沙箱）
- 离线可用（使用本地 SQLite 存储 Session）

**Web 端查看本地会话：**

- Electron 在本地模式下将 Session 事件同步到云端 PostgreSQL（标记为 `mode: 'local'`）
- Web 端可查看这些本地会话，但所有操作按钮置灰，显示 "本地会话，只读"
- 同步通过后台队列完成，支持离线后补传

### 5.4 前端 UI 核心页面

| 页面 | 路由 | 说明 |
| --- | --- | --- |
| 登录 | `/login` | GitHub/Google/Apple OAuth |
| 会话列表 | `/` | 所有会话（标注远程/本地） |
| 对话 | `/chat/:id` | 对话界面 + 工具执行面板 |
| 沙箱 | `/chat/:id/sandbox` | 文件浏览器 + 终端 + 代码预览 |
| 设置 | `/settings` | 模型配置、API Key、偏好 |

---

## 六、API 设计

### 6.1 RESTful API

```
Auth:
  POST   /api/auth/sign-in/:provider    # OAuth 登录
  POST   /api/auth/sign-out             # 登出
  GET    /api/auth/session              # 当前会话

Sessions:
  GET    /api/sessions                  # 列表（分页 + 筛选 mode）
  POST   /api/sessions                  # 创建
  GET    /api/sessions/:id              # 详情
  DELETE /api/sessions/:id              # 删除
  PATCH  /api/sessions/:id              # 更新（标题等）

Messages:
  POST   /api/sessions/:id/messages     # 发送消息（触发 Agent）
  GET    /api/sessions/:id/events       # 拉取事件（分页）

Sandbox:
  POST   /api/sandboxes                 # 创建沙箱
  GET    /api/sandboxes/:id/files       # 文件列表
  GET    /api/sandboxes/:id/files/*     # 读取文件
  PUT    /api/sandboxes/:id/files/*     # 写入文件
  POST   /api/sandboxes/:id/execute     # 执行代码
  DELETE /api/sandboxes/:id             # 销毁沙箱

Sync (for Electron local mode):
  POST   /api/sync/events              # 批量同步本地事件到云端
  GET    /api/sync/status              # 同步状态
```

### 6.2 WebSocket / SSE

```
WS /api/sessions/:id/stream

Client → Server:
  { type: "subscribe", sessionId: "..." }
  { type: "message", content: "..." }
  { type: "cancel" }                     # 取消当前生成

Server → Client:
  { type: "event", event: SessionEvent }  # 实时事件推送
  { type: "heartbeat" }
  { type: "error", message: "..." }
```

---

## 七、数据流

### 7.1 远程模式对话流

```
User (Web/Electron)
  │
  ├─1─► POST /api/sessions/:id/messages { content: "帮我写个Python爬虫" }
  │
  ├─2─► WS /api/sessions/:id/stream (订阅)
  │
  ▼
API Gateway (Hono)
  │
  ├─3─► Session Service: 写入 user.message 事件
  │
  ├─4─► Brain Service: 启动 Harness Loop
  │     │
  │     ├─5─► LLM Call (streaming) → 写入 brain.thinking 事件
  │     │
  │     ├─6─► LLM 返回 tool_call: execute_code
  │     │     │
  │     │     ├─7─► Session Service: 写入 brain.tool_call 事件
  │     │     │
  │     │     ├─8─► Hands Service: executeCode(sandbox, code)
  │     │     │     │
  │     │     │     └─9─► E2B Sandbox: 执行代码
  │     │     │
  │     │     ├─10─► Session Service: 写入 hands.tool_result 事件
  │     │     │
  │     │     └─11─► 回到 Step 5 (继续循环)
  │     │
  │     └─12─► LLM 返回最终 message → 写入 brain.message 事件
  │
  └─13─► WebSocket 推送所有事件到 Client (实时渲染)
```

### 7.2 本地模式对话流

```
User (Electron)
  │
  ├─1─► IPC: send-message { content: "打开我的项目文件夹" }
  │
  ▼
Electron Main Process
  │
  ├─2─► Local Session: 写入 user.message (SQLite)
  │
  ├─3─► Local Brain: Mastra Agent (进程内运行)
  │     │
  │     ├─4─► LLM Call → 返回 tool_call: read_local_dir
  │     │
  │     ├─5─► Local Hands: fs.readdir('/Users/xxx/projects')
  │     │
  │     └─6─► LLM 返回最终 message
  │
  ├─7─► IPC: 推送事件到 Renderer
  │
  └─8─► Background Sync: 事件批量上传到云端（标记只读）
```

---

## 八、Docker 部署架构

### 8.1 Docker Compose 编排

```yaml
# docker-compose.yml（结构示意）
services:
  # ──── 基础设施 ────
  postgres:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: agent_harness

  redis:
    image: valkey/valkey:8-alpine

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"

  # ──── 应用服务 ────
  api:
    build: ./apps/server
    depends_on: [postgres, redis, minio]
    environment:
      DATABASE_URL: postgres://...
      REDIS_URL: redis://redis:6379
      E2B_API_KEY: ${E2B_API_KEY}
      BETTER_AUTH_SECRET: ${AUTH_SECRET}
    ports:
      - "3001:3001"

  web:
    build: ./apps/web
    depends_on: [api]
    environment:
      NEXT_PUBLIC_API_URL: <http://api:3001>
    ports:
      - "3000:3000"

  # ──── 沙箱（自托管模式） ────
  sandbox-manager:
    build: ./services/sandbox-manager
    privileged: true          # Docker-in-Docker 需要
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on: [redis]

volumes:
  pgdata:
```

### 8.2 部署拓扑

```
                    ┌──────────────┐
                    │   Nginx /    │
                    │   Caddy      │
                    │   (TLS终结)  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Web      │ │ API      │ │ API      │
        │ (Next.js)│ │ Instance │ │ Instance │
        │          │ │ 1        │ │ 2        │
        └──────────┘ └────┬─────┘ └────┬─────┘
                          │            │
              ┌───────────┼────────────┘
              ▼           ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │PostgreSQL│ │ Redis    │ │ MinIO    │
        │ (主从)   │ │ (Cluster)│ │          │
        └──────────┘ └──────────┘ └──────────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              ┌──────────┐ ┌──────────┐
              │ Sandbox  │ │ Sandbox  │
              │ Pool     │ │ Pool     │
              │ (E2B/DnD)│ │ (E2B/DnD)│
              └──────────┘ └──────────┘
```

---

## 九、安全设计

| 层面 | 策略 |
| --- | --- |
| **鉴权** | Better Auth JWT + CSRF 保护 + HttpOnly Cookie |
| **沙箱隔离** | 生产用 E2B microVM（独立内核），自托管用 gVisor/Sysbox |
| **网络** | 沙箱默认禁止出站，白名单放行特定域名 |
| **文件** | 沙箱内文件不可访问宿主机，通过 API 中转 |
| **API Key** | 用户 LLM API Key 加密存储（AES-256-GCM），Brain 运行时解密 |
| **本地模式** | 用户显式授权目录/命令白名单，Electron contextIsolation 开启 |
| **速率限制** | Redis 令牌桶，per-user + per-IP |
| **审计** | 所有 tool_call 记录在 Session 事件中，不可篡改 |

---

## 十、Electron 本地模式详细设计

### 10.1 本地 Agent 运行时

```
Electron Main Process
├── LocalAgentRuntime
│   ├── brain: Mastra Agent (进程内, 直连 LLM API)
│   ├── hands: LocalHandsProvider
│   │   ├── FileSystemTool (受限于授权目录)
│   │   ├── ShellTool (白名单命令)
│   │   ├── AppControlTool (打开URL/应用)
│   │   └── ClipboardTool (读写剪贴板)
│   └── session: SQLiteSessionStore
│
├── SyncService
│   ├── 监听本地 Session 变更
│   ├── 批量上传到云端 (POST /api/sync/events)
│   └── 冲突解决: 本地事件 append-only, 云端只接受新增
│
└── IPC Bridge
    ├── handle('agent:send-message', ...)
    ├── handle('agent:get-sessions', ...)
    ├── handle('agent:switch-mode', ...)
    └── handle('sandbox:file-access', ...)
```

### 10.2 本地/远程模式数据流对比

| 维度 | 远程模式 | 本地模式 |
| --- | --- | --- |
| Agent 执行位置 | 云端 API Server | Electron Main Process |
| 沙箱 | E2B / 云端 Docker | 本地受限 shell |
| Session 存储 | PostgreSQL (云端) | SQLite (本地) + 异步同步到云端 |
| 通信协议 | HTTPS + WebSocket | Electron IPC |
| 文件操作 | 沙箱内虚拟文件系统 | 用户本地文件系统（授权后） |
| Web 可见性 | 完整交互 | 只读查看 |

---

## 十一、项目目录结构（Monorepo）

```
agent-harness/
├── package.json                    # Workspace root
├── turbo.json                      # Turborepo 配置
├── docker-compose.yml
├── docker-compose.prod.yml
│
├── packages/
│   ├── ui/                         # 共享 UI 组件库
│   │   ├── src/
│   │   │   ├── components/         # shadcn 组件
│   │   │   │   ├── chat/           # 对话组件
│   │   │   │   ├── sandbox/        # 沙箱面板组件
│   │   │   │   ├── auth/           # 登录组件
│   │   │   │   └── layout/         # 布局组件
│   │   │   └── index.ts
│   │   ├── tailwind.config.ts
│   │   └── package.json
│   │
│   ├── shared/                     # 共享逻辑
│   │   ├── src/
│   │   │   ├── types/              # 全局类型定义
│   │   │   │   ├── session.ts
│   │   │   │   ├── agent.ts
│   │   │   │   └── sandbox.ts
│   │   │   ├── stores/             # Zustand stores
│   │   │   │   ├── session-store.ts
│   │   │   │   ├── auth-store.ts
│   │   │   │   └── sandbox-store.ts
│   │   │   ├── api/                # API client (fetch wrapper)
│   │   │   │   ├── client.ts
│   │   │   │   ├── sessions.ts
│   │   │   │   └── auth.ts
│   │   │   └── utils/
│   │   └── package.json
│   │
│   └── db/                         # 数据库 schema & migrations
│       ├── src/
│       │   ├── schema/             # Drizzle ORM schema
│       │   └── migrations/
│       └── package.json
│
├── apps/
│   ├── web/                        # Next.js Web App
│   │   ├── app/
│   │   │   ├── (auth)/
│   │   │   │   └── login/
│   │   │   ├── (dashboard)/
│   │   │   │   ├── page.tsx        # 会话列表
│   │   │   │   └── chat/
│   │   │   │       └── [id]/
│   │   │   │           └── page.tsx
│   │   │   ├── settings/
│   │   │   └── layout.tsx
│   │   ├── next.config.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── desktop/                    # Electron App
│   │   ├── main/
│   │   │   ├── index.ts            # Electron 入口
│   │   │   ├── local-agent/
│   │   │   │   ├── runtime.ts      # 本地 Agent 运行时
│   │   │   │   ├── tools/          # 本地工具
│   │   │   │   └── sandbox.ts      # 本地沙箱
│   │   │   ├── ipc/
│   │   │   │   └── handlers.ts     # IPC 处理器
│   │   │   ├── sync/
│   │   │   │   └── sync-service.ts # 云端同步
│   │   │   └── store/
│   │   │       └── sqlite.ts       # 本地 SQLite
│   │   ├── preload/
│   │   │   └── index.ts
│   │   ├── renderer/               # 指向 web 的构建产物或 dev server
│   │   ├── electron-builder.yml
│   │   └── package.json
│   │
│   └── server/                     # Hono + Bun 后端
│       ├── src/
│       │   ├── index.ts            # 入口
│       │   ├── app.ts              # Hono app 配置
│       │   ├── middleware/
│       │   │   ├── auth.ts         # Better Auth 中间件
│       │   │   ├── rate-limit.ts
│       │   │   └── cors.ts
│       │   ├── routes/
│       │   │   ├── auth.ts
│       │   │   ├── sessions.ts
│       │   │   ├── messages.ts
│       │   │   ├── sandboxes.ts
│       │   │   └── sync.ts
│       │   ├── services/
│       │   │   ├── session-service.ts
│       │   │   ├── brain-service.ts
│       │   │   ├── hands-service.ts
│       │   │   └── sandbox-pool.ts
│       │   ├── agents/             # Mastra Agent 定义
│       │   │   ├── harness-agent.ts
│       │   │   ├── tools/
│       │   │   └── workflows/
│       │   └── lib/
│       │       ├── auth.ts         # Better Auth 实例
│       │       ├── db.ts           # Drizzle + PostgreSQL
│       │       └── redis.ts
│       ├── Dockerfile
│       └── package.json
│
└── infra/
    ├── nginx/
    │   └── nginx.conf
    ├── scripts/
    │   ├── setup.sh
    │   └── seed.ts
    └── k8s/                        # (可选) K8s manifests
        └── ...
```

---

## 十二、开发与构建流程

### 12.1 Monorepo 管理

- **包管理器**：Bun workspace
- **代码质量**：Biome (lint + format，替代 ESLint + Prettier)

### 12.2 开发命令

```bash
# 安装依赖
bun run install

# 启动全部开发环境
bun run dev                    # turbo run dev --parallel

# 分别启动
bun run dev:web               # Next.js dev server (port 3000)
bun run dev:server            # Bun + Hono dev (port 3001)
bun run dev:desktop           # Electron + Next.js dev
bun run dev:infra             # docker compose up postgres redis minio

# 构建
bun run build                 # 全量构建
bun run build:docker          # docker compose build
bun run build:desktop         # electron-builder 打包

# 数据库
bun run db:migrate            # 执行迁移
bun run db:seed               # 填充测试数据
```

---

## 十三、扩展性考虑

| 扩展方向 | 设计预留 |
| --- | --- |
| **多模型支持** | Mastra 原生支持 OpenAI / Anthropic / Google 等，通过配置切换 |
| **自定义工具** | 统一 Tool Interface，用户可通过 MCP 协议接入自定义工具 |
| **插件系统** | Hands 层通过 Provider Pattern 支持插件化沙箱/工具 |
| **多租户** | Session/Sandbox 均绑定 user_id，数据隔离，后续可加 org 层级 |
| **Agent 市场** | Agent 定义存储在 DB 中，支持 CRUD，未来可做分享/市场 |
| **语音交互** | Mastra 原生支持 Voice，预留接口 |
| **水平扩展** | Brain 无状态可横向扩容，通过 Redis pub/sub 协调 |

---

## 十四、实施路线图（建议）

| 阶段 | 周期 | 目标 |
| --- | --- | --- |
| **Phase 0: 基建** | 1 周 | Monorepo 搭建、Docker Compose、DB Schema、Better Auth 鉴权跑通 |
| **Phase 1: 远程核心** | 2 周 | Session Service + Brain Service (Mastra) + 基础对话 UI |
| **Phase 2: 沙箱** | 2 周 | Hands Service + E2B/Docker 沙箱 + 文件浏览器 UI |
| **Phase 3: Electron** | 2 周 | Electron 壳 + 本地模式 Agent + IPC 通信 |
| **Phase 4: 同步** | 1 周 | 本地→云端事件同步 + Web 只读查看本地会话 |
| **Phase 5: 打磨** | 2 周 | UI 打磨、错误处理、安全加固、性能优化 |

---

## 十五、总结

本方案的核心创新点在于：

1. **完全对齐 Anthropic Managed Agents 的解耦哲学**：Brain / Hands / Session 三层分离，每层可独立演进和替换
2. **Mastra + Hono + Bun 的黄金搭配**：TypeScript 全栈，Mastra 原生 Hono 适配器实现零摩擦集成
3. **Electron 双模式架构**：远程模式享受云端沙箱的安全隔离，本地模式获得操作本机的便利性
4. **Web 只读本地会话**：通过异步事件同步机制，在不破坏安全边界的前提下实现跨端可见
5. **统一沙箱抽象层**：一个 `SandboxProvider` 接口适配 E2B / Docker / 本地三种执行环境