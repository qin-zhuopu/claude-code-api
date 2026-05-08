# Claude Code API

REST API 服务，将 `@anthropic-ai/claude-agent-sdk` 封装为 HTTP 接口。

## 功能

- **POST /api/query** - 执行 Claude 查询（SSE 流式响应）
- **POST /api/query/interrupt** - 中断正在执行的查询
- **POST /api/query/stats** - 获取活跃查询统计

## 安装

```bash
npm install
```

## 运行

```bash
# 开发模式
npm run start:dev

# 生产模式
npm run build
npm run start:prod
```

服务默认运行在 `http://localhost:3000`

## API 使用

### 执行查询

```bash
curl -N -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is 2+2?"}'
```

### 带选项的查询

```bash
curl -N -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "List files in current directory",
    "options": {
      "cwd": "/path/to/project"
    }
  }'
```

### SSE 响应格式

```
data: {"type":"text","content":"..."}
data: {"type":"tool_use","toolName":"Bash","toolInput":{...}}
data: {"type":"tool_result","content":"..."}
data: {"type":"done"}
```

## 项目结构

```
src/
├── main.ts              # 应用入口
├── app.module.ts        # 根模块
└── query/               # Query 模块
    ├── query.controller.ts   # REST 控制器
    ├── query.service.ts      # 业务逻辑
    └── dto/                  # 数据传输对象
```

## 测试

```bash
npm run test:e2e
```
