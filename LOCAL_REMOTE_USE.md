# GitNexus 内部使用指南

欢迎使用团队定制版的 GitNexus 知识图谱引擎！

通过 GitNexus，你可以让大模型（如 Claude Code）全面掌握我们庞大且复杂的内部代码仓库的结构和调用链，而不会因为超出上下文而报错。为降低你电脑的算力负担并保证分析一致性，我们推荐直接接入**内部公共的远端解析服务器**。如有特殊本地化需求，也可以按需执行下文的纯本地离线安装方案也一样好用。

---

## ⚡ 推荐方案：零安装直连公共测试服务器（免算力开销）

我们已经在远端的公用服务器（内网地址根据分配为准，以下假设为 `192.168.1.100`）运行了全量仓库的知识图谱索引与通信后端。作为终端用户，你**无需在本地安装任何额外的 GitNexus 环境**，所有分析和查询压力均通过通道转移在核心服务端集中处理！你可以通过以下两种方式连接到该服务器：

### 挂载方式一：SSH 隧道直连（推荐，免写代码）
如果你有这台内网服务器的 SSH 登录权限，可以直接通过底层的数据管道透传！
在你本地正工作的任何开发根目录下，配置 Claude Code：

```bash
claude mcp add gitnexus -- ssh <你的用户名>@192.168.1.100 "cd /远程代码主仓库绝对路径 && gitnexus mcp"
```

### 挂载方式二：JS Proxy 代理脚本连接（适用于无 SSH 权限，纯 HTTP 网络环境）
如果团队为了安全没有开放 SSH，但该内网服务器能够直接访问（即 `http://192.168.1.100:4747/...` 开放）。
系统支持原生的 Server-Sent Events (SSE) 协议进行穿透。请在本地新建一个名为 `proxy.js` 的文件，填入以下透传代码：

```javascript
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import readline from "node:readline";

// 替换为您服务器的真实内网地址和端口
const transport = new SSEClientTransport(new URL("http://192.168.1.100:4747/api/mcp"));

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
claude mcp add gitnexus -- node proxy.js
```

配置成功后正常启动 `claude`，你的 AI 助手便拥有了超级权限。直接吩咐它 *“帮我在整个群组服务中分析这段接口如果修改，它上下游的爆炸半径是多少”* 即可体验！

---

## 🛠 远端公用服务器是如何部署的？(面向内部维护者)

如果你是团队内网这台 `192.168.1.100` 服务器的负责人，你需要在这台机器上常驻运行服务端引擎。最标准且最稳定的部署方式是使用 **Docker 容器编排**。

### 采用 Docker 一键常驻部署
我们内置了生产级别的 `docker-compose.yaml`，它会同时拉起后端的 API/MCP 服务器以及前端 Web 界面：

1. **设置扫描目录并拉起所有容器**：
通过挂载宿主机的内网代码总文件夹建立环境（假设你们的企业代码都集中放在这台机器的 `$HOME/code` 下）：
```bash
WORKSPACE_DIR=$HOME/code docker compose up -d
```
启动完毕后，后端 MCP 数据端口 `4747` 以及 Web UI 浏览端口 `4173` 将常驻后台运行并保持自动重启状态。

2. **建立全量索引映射**：
由于宿主机的代码目录现已被只读挂载于容器的 `/workspace` 路经里，你需要命令容器对指定业务域进行一次扫描建库：
```bash
docker compose exec gitnexus-server gitnexus analyze /workspace/你的目标代码仓库名
```
至此，维护者的任务大功告成！前端研发即可使用上面提到的 `SSH` 隧道口令无缝访问这台服务器产出的智能上下文了。

*(如果你不想使用 Docker，也可以直接在服务器上使用 `pm2 start "npx gitnexus serve" --name gitnexus-backend` 等进程守护工具直接暴力保活原生 Node 进程，效果等同)*

---

## 💾 备选方案：离线包本地纯端安装 (适合出差断网或隔离单独调试)

如果你被隔离在特殊保密网段无法连接公用服务器，或者你想在自己私有分支上独立运行重度解析。你可以向项目维护负责人索要一份**内置了本司改动代码的内网离线安装包**（形如 `gitnexus-1.6.2.tgz` 格式的文件）。

### 1. 全局解压与安装
拿到离线 `.tgz` 压缩包后，放置在你的任意目录下，并在你的终端内进行全局安装：

```bash
# 修改下方路径为你存放 tgz 安装包的实际绝对路径
npm install -g /你的路径/gitnexus-1.6.2.tgz
```
安装结束后，你的开发机环境中即注册了专属于团队版本的 `gitnexus` 行令。

### 2. 扫瞄你的本地目录
进入你需要重构的大型项目根路径，呼唤其纯依赖本机算力建立全新的本地索引（建完会存储在项目 `.gitnexus` 文件夹下）：
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
💡 **关于升级**: 若团队发布了包含新优化的更新的 `.tgz` 发行版依赖包，在离线场景下你只需要重新跑一遍上述的 `npm install -g` 命令，系统即刻平滑覆盖更新你的代码逻辑网络。
