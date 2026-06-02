# Sandbox Windows 不支持行为观察

## 核心发现摘要

| 发现 | 结论 |
|------|------|
| Windows 上 `sandbox.enabled=true`（默认 `failIfUnavailable`） | SDK 抛异常，不发出任何 API 请求 |
| `failIfUnavailable: false` | 降级运行，sandbox 未实际启用，请求正常发出 |
| `sandbox.enabled: false` / 未设置 | 正常运行，等同基线 |
| sandbox 配置对请求结构的影响 | 无影响：tools 数量(23)、system blocks(2) 均一致 |
| 异常消息 | `"Sandbox required but unavailable: sandbox.enabled is set but windows is not supported (requires macOS, Linux, or WSL2). Set sandbox.failIfUnavailable=false to allow unsandboxed execution."` |

## 实验矩阵

| Case | enabled | failIfUnavailable | filesystem/network | thrownError | request files | tools count | result subtype |
|------|---------|-------------------|--------------------|-------------|---------------|-------------|----------------|
| 1 基线 | 未设置 | - | - | null | 1 | 23 | success |
| 2 默认 | true | 默认(=true) | - | ✅ Error | 0 | - | error (via exception) |
| 3 降级 | true | false | - | null | 1 | 23 | success |
| 4 显式硬失败 | true | true | - | ✅ Error | 0 | - | error (via exception) |
| 5 全配置 | true | false | ✅ full config | null | 1 | 23 | success |
| 6 显式禁用 | false | - | - | null | 1 | 23 | success |

## 详细发现

### 1. 异常机制：Error throw，不是 result 事件

SDK 在 Windows 上检测到 `sandbox.enabled=true` + 平台不支持时：
- **不是**通过 `result.subtype === 'error'` 返回错误
- **而是**在 `for await` 迭代器中直接 `throw new Error(...)`
- 异常前会产出 1 个 event（error result），但 `for await` 不会让它被正常消费
- 异常消息格式：`"Claude Code returned an error result: Sandbox required but unavailable: sandbox.enabled is set but windows is not supported (requires macOS, Linux, or WSL2). Set sandbox.failIfUnavailable=false to allow unsandboxed execution."`

**对 SDK 消费者的影响**：调用方必须 try-catch `for await` 循环，不能仅依赖 `result.subtype` 判断。

### 2. failIfUnavailable 默认值确认

SDK 注释说 "When `enabled: true` is passed via this option, `failIfUnavailable` defaults to `true`"。实验验证：
- Case 2（不设 failIfUnavailable）与 Case 4（显式 `true`）行为一致 → 确认默认为 `true`
- 两者都抛相同的异常

### 3. failIfUnavailable=false 的降级行为

Case 3 和 Case 5 设置 `failIfUnavailable: false`：
- 不抛异常
- 正常产出请求/响应文件
- `result.subtype === 'success'`
- sandbox 配置（filesystem、network）**被完全忽略**，不影响请求结构
- 请求结构与基线（case 1）完全一致

### 4. sandbox 配置不影响 API 请求结构

对比 case 1/3/5/6 的请求文件：
- **tools 数量**：均为 23
- **system blocks**：均为 2
- **请求体结构**：完全一致（102 个 unique keys）
- sandbox 的 filesystem/network 配置**不会**反映在 API 请求中

这说明 sandbox 是纯 CLI 侧的 OS 级隔离，不是 API 参数。Bash 工具的 `dangerouslyDisableSandbox` 参数存在于 input_schema 中（在请求文件的 keys 中可见），但 sandbox 开关本身不修改 API 请求。

### 5. 异常时无 API 请求

Case 2 和 Case 4 抛异常时：
- 日志目录存在但**无任何 `.request.json` 文件**
- SDK 在启动阶段就检测到平台不支持，直接报错退出
- 不会浪费一次 API 调用

## 实际应用建议

### Windows SDK 消费者

1. **不要在原生 Windows 上启用 sandbox**：如果你确定运行在 Windows 上，直接不设 `sandbox` 或设 `sandbox: { enabled: false }`
2. **跨平台代码需 try-catch**：
   ```typescript
   try {
     for await (const msg of query({ ..., options: { sandbox: { enabled: true } } })) {
       // ...
     }
   } catch (err) {
     if (err.message?.includes('windows is not supported')) {
       // Windows 上的预期行为，降级处理
     }
   }
   ```
3. **用 failIfUnavailable: false 实现自动降级**：让代码在所有平台上都能运行，sandbox 在支持的平台上自动启用

### 平台检测策略

```typescript
const isWindows = process.platform === 'win32';
const isWSL = /* 检测 WSL 环境 */;

const sandboxConfig = isWindows && !isWSL
  ? { enabled: false }  // Windows 原生不支持
  : { enabled: true, failIfUnavailable: false };  // 其他平台尝试启用
```

## 未验证行为

- WSL2 环境下 sandbox 的实际行为（需要 WSL2 + bubblewrap + socat 安装）
- macOS 上 sandbox.enabled=true 的实际隔离效果
- sandbox.enabled + Bash 工具调用时的 `dangerouslyDisableSandbox` 参数行为
- autoAllowBashIfSandboxed 对 Bash 权限提示的影响
- sandbox 配置通过 settings 文件（而非 query 选项）传入时的行为
- managed settings 中 sandbox 配置的优先级

## 测试文件

`test/integration/sandbox-windows-unsupported.spec.ts`（6 cases）
