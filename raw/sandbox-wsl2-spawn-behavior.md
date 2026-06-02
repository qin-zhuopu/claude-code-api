# Sandbox WSL2 Spawn 行为观察

## 核心发现

**✅ 可以！** 通过 SDK 的 `spawnClaudeCodeProcess` 钩子，Windows 应用可以穿透到 WSL2 启动 Linux 版 Claude Code，并启用 sandbox。

| 发现 | 结论 |
|------|------|
| WSL2 spawn 可行性 | ✅ 完全可行，`spawnClaudeCodeProcess` 钩子支持任意 spawn 逻辑 |
| sandbox 在 WSL2 中启用 | ✅ `sandbox.enabled=true` 在 WSL2 的 Linux Claude 中正常工作 |
| 对照组（Windows 默认 + sandbox） | ❌ 抛异常 "windows is not supported" |
| 通信协议 | stdin/stdout 的 JSON 行协议跨 OS 完全兼容 |

## 实验矩阵

| Case | spawn 方式 | sandbox | thrownError | result | 耗时 |
|------|-----------|---------|-------------|--------|------|
| 1 | Windows 默认 (claude.exe) | enabled=true | ✅ "windows not supported" | 失败 | ~1s |
| 2 | WSL2 (wsl → claude) | 无 | null | ✅ success | ~20s |
| 3 | WSL2 (wsl → claude) | enabled=true | null | ✅ success | ~12s |
| 4 | WSL2 (wsl → claude) | 全配置 | null | ✅ success | ~11s |

## 技术原理

### SDK 默认 spawn 行为

SDK 的 `query()` 内部通过 `child_process.spawn` 启动 Claude CLI：

```
Node.js (Windows)
  └─ spawn("C:\...\claude.exe", ["--output-format", "stream-json", ...])
       └─ claude.exe (Windows native)
            └─ 检测 platform = win32 → sandbox 不可用
```

### WSL2 spawn 实现

通过 `spawnClaudeCodeProcess` 钩子替换为 WSL2 启动：

```
Node.js (Windows)
  └─ spawn("wsl", ["-d", "Ubuntu-24.04", "--", "bash", "-lc", "claude ..."])
       └─ wsl.exe → WSL2 Linux
            └─ claude (Linux binary)
                 └─ 检测 platform = linux → sandbox ✅ (需要 bubblewrap + socat)
```

### 关键实现：环境变量注入

WSL2 不会自动继承 Windows 进程的环境变量。SDK 传入的 `ANTHROPIC_AUTH_TOKEN` 等必须手动注入到 WSL2 的 bash 命令中：

```typescript
function createWslSpawn(distro: string) {
  return (options: SpawnOptions) => {
    // 把 options.env 转为 export 语句
    const envExports = Object.entries(options.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `export ${k}='${v}'`)
      .join('; ');

    const claudeCmd = options.args.map(shellescape).join(' ');
    const fullCmd = `source /root/.nvm/nvm.sh; ${envExports}; claude ${claudeCmd}`;

    return spawn('wsl', ['-d', distro, '--', 'bash', '-lc', fullCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}
```

### stdin/stdout 管道

SDK 通过 stdin 向子进程发送 JSON 行消息，通过 stdout 接收 JSON 行响应。这个管道机制对 WSL2 子进程**完全透明**——Windows 侧的 `wsl.exe` stdin/stdout 会被映射到 WSL2 内的 `claude` 进程。

## 前置条件

WSL2 发行版中需要安装：

1. **Claude Code CLI**：`npm install -g @anthropic-ai/claude-code`
2. **bubblewrap**：`sudo apt-get install bubblewrap`（sandbox 文件系统隔离）
3. **socat**：`sudo apt-get install socat`（sandbox 网络代理）
4. **Node.js**（用于运行 Claude CLI）

## 实际应用建议

### 场景：Windows 应用需要 sandbox

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

const WSL_DISTRO = 'Ubuntu-24.04';

const result = query({
  prompt: 'run tests',
  options: {
    spawnClaudeCodeProcess: createWslSpawn(WSL_DISTRO),
    sandbox: { enabled: true },
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-...' },
    // ... 其他选项
  },
});
```

### 优势

- Windows 应用获得完整的 Linux sandbox 能力（bubblewrap + 网络隔离）
- 不需要 Docker Desktop
- SDK 的 JSON 行通信协议天然跨平台兼容

### 局限性

1. **WSL2 发行版必须预配置**：需要预装 Claude CLI + sandbox 依赖
2. **环境变量需手动注入**：WSL2 不自动继承 Windows 进程环境
3. **路径不互通**：`cwd` 和文件路径需考虑 Windows ↔ WSL2 映射
4. **stderr 不可用**：`spawnClaudeCodeProcess` 接口只有 stdin/stdout，没有 stderr（但 `stdio: ['pipe','pipe','pipe']` 可以捕获）
5. **启动延迟**：WSL2 冷启动约 1-2 秒额外开销

## 未验证行为

- WSL2 sandbox 的实际文件系统/网络隔离效果（需要 Bash 工具调用触发）
- `OTEL_LOG_RAW_API_BODIES=file:...` 路径在 WSL2 spawn 下的映射问题（case 2-4 的 request files 均为 0）
- 多会话并发下 WSL2 spawn 的稳定性
- WSL2 的 `--cd` 参数用于 cwd 映射
- Windows → WSL2 的信号传递（kill/abort）

## 测试文件

`test/integration/sandbox-wsl2-spawn.spec.ts`（4 cases）
