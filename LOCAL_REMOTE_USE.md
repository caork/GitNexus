# GitNexus 内部使用指南

欢迎使用团队定制版的 GitNexus 知识图谱引擎！

通过 GitNexus，你可以让大模型（如 Claude Code）全面掌握我们庞大且复杂的内部代码仓库的结构和调用链，而不会因为超出上下文而报错。为降低你电脑的算力负担并保证分析一致性，我们推荐直接接入**内部公共的远端解析服务器**。如有特殊本地化需求，也可以按需执行下文的纯本地离线安装方案也一样好用。

---

## ⚡ 推荐方案：零安装直连公共测试服务器（免算力开销）

我们已经在远端的公用服务器（内网地址根据分配为准，以下假设为 `192.168.1.100`）运行了全量仓库的知识图谱索引与通信后端。作为终端用户，你**无需在本地安装任何额外的 GitNexus 环境**，所有分析和查询压力均通过通道转移在核心服务端集中处理！你可以通过以下三种方式连接到该服务器：

### 挂载方式一：`--remote` 参数直连（最简单，本地已装 gitnexus 时首选）

如果你本地已经通过离线包安装了 `gitnexus`，直接用 `--remote` 参数指向服务器，一行命令搞定，无需写任何代理脚本：

```bash
claude mcp add gitnexus -- gitnexus mcp --remote http://192.168.1.100:4747
```

本地的 `gitnexus mcp` 进程会自动将所有工具调用转发给远端服务器，完全透明。

### 挂载方式二：SSH 隧道直连（适合有 SSH 权限、本地未装 gitnexus）

如果你有这台内网服务器的 SSH 登录权限，可以直接通过底层的数据管道透传，无需本地安装任何 gitnexus：

```bash
# 原生安装的机器：
claude mcp add gitnexus -- ssh <你的用户名>@192.168.1.100 "gitnexus mcp"

# 若远端是使用下文介绍的 Docker 环境部署的：
claude mcp add gitnexus -- ssh <你的用户名>@192.168.1.100 "docker exec -i gitnexus-server gitnexus mcp"
```

### 挂载方式三：JS Proxy 代理脚本（无 SSH 权限、纯 HTTP 网络环境）

如果团队为了安全没有开放 SSH，但该内网服务器的 HTTP 端口可直接访问（即 `http://192.168.1.100:4747` 开放）。在本地新建一个名为 `proxy.mjs`（注意使用 `.mjs` 后缀以支持 ES6 Import）的文件，填入以下透传代码：

```javascript
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import readline from "node:readline";

// 替换为您服务器的真实内网地址和端口
const transport = new StreamableHTTPClientTransport(new URL("http://192.168.1.100:4747/api/mcp"));

async function start() {
  await transport.start();

  transport.onmessage = (message) => {
    console.log(JSON.stringify(message));
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    try {
      const msg = JSON.parse(line);
      await transport.send(msg);
    } catch (e) {
      // 忽略无效心跳
    }
  });
}
start().catch(console.error);
```

**前置安装 SDK 工具包**：在这份脚本所在的目录下执行 `npm install @modelcontextprotocol/sdk`。

**完成挂载**：在同一目录下向 Claude Code 提交该入口：
```bash
claude mcp add gitnexus -- node proxy.mjs
```

配置成功后正常启动 `claude`，你的 AI 助手便拥有了超级权限。直接吩咐它 *"帮我在整个群组服务中分析这段接口如果修改，它上下游的爆炸半径是多少"* 即可体验！

---

## 🛠 远端公用服务器是如何部署的？(面向内部维护者)

如果你是团队内网这台 `192.168.1.100` 服务器的负责人，你需要在这台机器上常驻运行服务端引擎。根据服务器是否能访问外网镜像源，有两种部署方式。

### 方式 A：Docker 一键常驻部署（有外网镜像源时首选）

我们内置了生产级别的 `docker-compose.yaml`，它会同时拉起后端的 API/MCP 服务器以及前端 Web 界面：

1. **设置扫描目录并拉起所有容器**：
   通过挂载宿主机的内网代码总文件夹建立环境（假设你们的企业代码都集中放在这台机器的 `$HOME/code` 下）：
   ```bash
   WORKSPACE_DIR=$HOME/code docker compose up -d
   ```
   启动完毕后，后端 MCP 数据端口 `4747` 以及 Web UI 浏览端口 `4173` 将常驻后台运行并保持自动重启状态。

2. **建立全量索引映射**：
   由于宿主机的代码目录现已被只读挂载于容器的 `/workspace` 路径里，你需要命令容器对指定业务域进行一次扫描建库：
   ```bash
   docker compose exec gitnexus-server gitnexus analyze /workspace/你的目标代码仓库名
   ```
   至此，初次部署的任务大功告成！

### 方式 B：离线 Bundle + pm2 部署（内网无 Docker 镜像源时使用）

`tree-sitter` 和 `onnxruntime-node` 均为原生二进制模块，**必须在与内网服务器相同 OS 和 CPU 架构的外网机器上打包**（例如都是 Linux x64）。`npm pack` 不含 `node_modules`，因此需要打包完整目录。

**第一步：在外网机器上构建 bundle**

```bash
# 克隆 fork 仓库
git clone https://github.com/caork/GitNexus.git
cd GitNexus/gitnexus

# 安装依赖（下载原生二进制）并编译 TypeScript
npm install
npm run build

# 打包完整目录（含 node_modules，排除缓存）
cd ..
tar --exclude='gitnexus/node_modules/.cache' \
    --exclude='gitnexus/.git' \
    -czf gitnexus-bundle.tar.gz gitnexus/
# 产物约 300–500 MB（onnxruntime 较大）
```

**第二步：传输到内网服务器并启动**

```bash
# 解压
mkdir -p ~/gitnexus-server
tar -xzf gitnexus-bundle.tar.gz -C ~/gitnexus-server
cd ~/gitnexus-server/gitnexus

# 注册全局命令
npm link

# 用 pm2 常驻启动（对外监听 0.0.0.0）
pm2 start "gitnexus serve --host 0.0.0.0 --port 4747" --name gitnexus-server
pm2 save       # 持久化配置，进程崩溃后自动重启
pm2 startup    # 生成开机自启命令（按提示执行一次）
```

**第三步：建立初始索引**

```bash
gitnexus analyze ~/code/你的目标代码仓库名
```

---

## 🔄 服务运维：索引更新与新增仓库（面向内部维护者）

### 如何知道扫描是否完成？

**CLI 方式**（直接执行 `gitnexus analyze`）：命令同步阻塞运行，进度条实时更新，结束后打印摘要并退出。**进程退出即代表完成**：

```
Repository indexed successfully (42s)
12834 nodes | 89201 edges | 47 clusters | 231 flows
/home/user/code/your-repo
```

**HTTP API 方式**（见下文，服务运行期间推荐）：`POST /api/analyze` 返回 `jobId`，轮询或订阅进度：

```bash
# 轮询状态（status 字段变为 "complete" 即完成）
curl http://localhost:4747/api/analyze/<jobId>

# 或实时订阅 SSE 进度流（收到 type:complete 事件即完成）
curl -N http://localhost:4747/api/analyze/<jobId>/progress
```

### 代码修改后如何更新索引？

**服务端不会自动监听文件变化**，需要手动触发重建。在服务运行期间，**务必通过 HTTP 接口触发**，不要直接跑 CLI 命令：

```bash
# 通过 HTTP API 触发增量重建（服务无需重启）
curl -X POST http://localhost:4747/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/code/your-repo"}'
```

服务端会在内部 fork 子进程执行 analyze，完成后自动重新加载索引，整个过程对正在查询的用户透明。

> **为什么不能直接跑 `gitnexus analyze`？** `gitnexus serve` 和 CLI 的 `analyze` 命令都会持有 LadybugDB 的文件锁，两个进程同时操作会产生冲突并损坏索引。HTTP 接口是服务进程自己内部协调，不存在这个问题。

**如果 HTTP 接口返回锁错误（极少见）**，用以下兜底方案：

```bash
pm2 stop gitnexus-server
gitnexus analyze /home/user/code/your-repo
pm2 start gitnexus-server
```

### 新增一个代码仓库

无需重启服务，直接 POST 新仓库路径即可。服务端在下一次工具调用时会自动发现并加载新仓库：

```bash
curl -X POST http://localhost:4747/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/code/new-repo"}'
```

---

## 💾 备选方案：离线包本地纯端安装（适合出差断网或隔离单独调试）

如果你被隔离在特殊保密网段无法连接公用服务器，或者你想在自己私有分支上独立运行重度解析。你可以向项目维护负责人索要一份**内置了本司改动代码的内网离线安装包**（形如 `gitnexus-1.6.2.tgz` 格式的文件，仅含 CLI，不含 `node_modules`，适合本地单机使用而非服务端部署）。

### 1. 全局解压与安装

拿到离线 `.tgz` 压缩包后，放置在你的任意目录下，并在你的终端内进行全局安装：

```bash
# 修改下方路径为你存放 tgz 安装包的实际绝对路径
npm install -g /你的路径/gitnexus-1.6.2.tgz
```

安装结束后，你的开发机环境中即注册了专属于团队版本的 `gitnexus` 命令。

### 2. 扫描你的本地目录

进入你需要重构的大型项目根路径，依赖本机算力建立全新的本地索引（建完会存储在项目 `.gitnexus` 文件夹下）：

```bash
gitnexus analyze
```

### 3. 配置智能体本地绑定

将刚刚建立在本地环境中的知识计算库供给给大模型本身：

```bash
claude mcp add gitnexus -- gitnexus mcp
```

一旦配对成功并运行 `claude` 即可。

---

💡 **关于升级**：若团队发布了包含新优化的更新的 `.tgz` 发行版依赖包，在离线场景下你只需要重新跑一遍上述的 `npm install -g` 命令，系统即刻平滑覆盖更新你的代码逻辑网络。
