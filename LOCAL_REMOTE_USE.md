# GitNexus 内部使用指南

GitNexus 是团队定制的代码知识图谱引擎，让大模型（如 Claude Code）全面掌握复杂内部仓库的结构与调用链，而不会因超出上下文而报错。

本文档分为两部分：**服务器端**（运维/维护者阅读）和**客户端**（所有团队成员阅读）。

---

## 一、服务器端

> 面向负责在内网机器上部署和维护 GitNexus 服务的同学。

### 1. 环境准备

根据服务器是否能访问外网，选择以下任一方式。

#### 方式 A：Docker（有外网镜像源时首选）

确保服务器已安装 Docker 和 Docker Compose，无需其他依赖。

#### 方式 B：离线 Bundle + pm2（无外网镜像源时使用）

`tree-sitter` 和 `onnxruntime-node` 是原生二进制模块，**必须在与内网服务器相同 OS 和 CPU 架构的外网机器上打包**。

在外网机器上构建 bundle：

```bash
git clone https://github.com/caork/GitNexus.git
cd GitNexus/gitnexus
npm install        # 下载原生二进制
npm run build      # 编译 TypeScript

cd ..
tar --exclude='gitnexus/node_modules/.cache' \
    --exclude='gitnexus/.git' \
    -czf gitnexus-bundle.tar.gz gitnexus/
# 产物约 300–500 MB（onnxruntime 较大）
```

将 `gitnexus-bundle.tar.gz` 传输到内网服务器。

---

### 2. 部署

#### 方式 A：Docker 一键部署

将企业代码目录（假设为 `$HOME/code`）挂载后启动：

```bash
WORKSPACE_DIR=$HOME/code docker compose up -d
```

启动后：
- `4747`：后端 MCP / API 端口
- `4173`：Web UI 浏览端口

两个服务均已配置自动重启。

#### 方式 B：离线 Bundle 部署

```bash
mkdir -p ~/gitnexus-server
tar -xzf gitnexus-bundle.tar.gz -C ~/gitnexus-server
cd ~/gitnexus-server/gitnexus

npm link              # 注册全局 gitnexus 命令

pm2 start "gitnexus serve --host 0.0.0.0 --port 4747" --name gitnexus-server
pm2 save              # 持久化配置，崩溃后自动重启
pm2 startup           # 生成开机自启命令（按提示执行一次）
```

---

### 3. 启动后：建立初始索引

服务启动后，需要对目标代码仓库执行一次全量扫描建库。

**方式 A（Docker 环境）**：

```bash
docker compose exec gitnexus-server gitnexus analyze /workspace/你的目标代码仓库名
```

**方式 B（原生环境）**：

```bash
gitnexus analyze ~/code/你的目标代码仓库名
```

扫描完成后终端会打印摘要并退出，**进程退出即代表完成**：

```
Repository indexed successfully (42s)
12834 nodes | 89201 edges | 47 clusters | 231 flows
/home/user/code/your-repo
```

---

### 4. 增量索引与仓库管理

#### 代码更新后重建索引

服务运行期间**务必通过 HTTP 接口触发**，不要直接跑 CLI 命令（两个进程同时持有 LadybugDB 文件锁会损坏索引）：

```bash
curl -X POST http://localhost:4747/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/code/your-repo"}'
```

服务端会内部 fork 子进程执行 analyze，完成后自动热重载索引，对正在查询的用户透明。

**轮询进度**（`status` 变为 `complete` 即完成）：

```bash
curl http://localhost:4747/api/analyze/<jobId>
```

**或实时订阅 SSE 进度流**（收到 `type:complete` 事件即完成）：

```bash
curl -N http://localhost:4747/api/analyze/<jobId>/progress
```

**兜底方案**（HTTP 接口返回锁错误时）：

```bash
pm2 stop gitnexus-server
gitnexus analyze /home/user/code/your-repo
pm2 start gitnexus-server
```

#### 新增仓库

无需重启服务，直接 POST 新路径即可：

```bash
curl -X POST http://localhost:4747/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/code/new-repo"}'
```

---

## 二、客户端

> 面向所有需要在 Claude Code 中使用 GitNexus 的团队成员。

团队已在内网服务器（以下假设地址为 `192.168.1.100`）上常驻运行全量索引服务，**无需本地安装任何 GitNexus 环境**，直接接入即可。

根据你的网络权限，选择以下任一接入方式。

---

### 方式一：`--remote` 参数直连（本地已装 gitnexus 时最简）

```bash
claude mcp add gitnexus -- gitnexus mcp --remote http://192.168.1.100:4747
```

本地的 `gitnexus mcp` 进程会自动将所有工具调用转发给远端，完全透明。

---

### 方式二：SSH 隧道直连（有 SSH 权限、本地未装 gitnexus）

```bash
# 原生部署的服务器：
claude mcp add gitnexus -- ssh <你的用户名>@192.168.1.100 "gitnexus mcp"

# Docker 部署的服务器：
claude mcp add gitnexus -- ssh <你的用户名>@192.168.1.100 "docker exec -i gitnexus-server gitnexus mcp"
```

---

### 方式三：JS Proxy 脚本（无 SSH 权限、纯 HTTP 网络环境）

**第一步**：在本地新建 `proxy.mjs`（注意 `.mjs` 后缀以支持 ES Module）：

```javascript
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import readline from "node:readline";

const transport = new StreamableHTTPClientTransport(new URL("http://192.168.1.100:4747/api/mcp"));

async function start() {
  await transport.start();
  transport.onmessage = (message) => { console.log(JSON.stringify(message)); };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    try { await transport.send(JSON.parse(line)); } catch (e) {}
  });
}
start().catch(console.error);
```

**第二步**：在脚本所在目录安装 SDK：

```bash
npm install @modelcontextprotocol/sdk
```

**第三步**：注册到 Claude Code：

```bash
claude mcp add gitnexus -- node proxy.mjs
```

---

### 验证接入是否成功

注册完成后启动 `claude`，在对话中执行：

```
列出 gitnexus 已索引的所有仓库
```

若返回仓库列表则接入成功，可以开始使用。

---

### 离线备选方案（断网或隔离网段）

如果无法连接内网服务器，可向项目维护者索取**本地离线安装包**（形如 `gitnexus-1.6.2.tgz`），按以下步骤在本机独立运行：

```bash
# 1. 全局安装
npm install -g /你的路径/gitnexus-1.6.2.tgz

# 2. 对目标仓库建立本地索引（索引存储在项目的 .gitnexus/ 下）
cd /你的项目路径
gitnexus analyze

# 3. 注册到 Claude Code
claude mcp add gitnexus -- gitnexus mcp
```

启动 `claude` 即可使用本地索引。

> 升级时重新执行 `npm install -g` 覆盖安装即可，索引无需重建。
