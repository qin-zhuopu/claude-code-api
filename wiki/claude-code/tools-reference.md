# Claude Code Tools Reference

**Sources**: raw/claude-code-docs/docs/tools-reference.md; raw/claude-code-docs/docs/permissions.md; raw/claude-code-docs/docs/permission-modes.md  
**Updated**: 2026-05-12

## Overview

Claude Code has access to a set of built-in tools that help it understand and modify codebases. The tools form a permission-based system with different risk levels - some are read-only and safe, while others have write/execute capabilities that can be dangerous if used improperly.

## Tool Categories by Permission Level

### Read-Only Tools (No Permission Required)

These tools can read information without any permission prompts. They are safe to use in any mode.

| Tool | Description | Behavior |
|------|-------------|----------|
| `Read` | Reads file contents with line numbers | Handles images, PDFs, Jupyter notebooks |
| `Glob` | Finds files by pattern matching | Supports `**` for recursive matching |
| `Grep` | Searches file contents using ripgrep | Respects `.gitignore`, supports regex |
| `LSP` | Code intelligence via language servers | Jump to definitions, find references, type errors |
| `ListMcpResourcesTool` | Lists resources from MCP servers | No specifier available |
| `ReadMcpResourceTool` | Reads specific MCP resource by URI | No specifier available |
| `WebSearch` | Performs web searches | Returns titles and URLs, doesn't fetch pages |
| `Agent` | Spawns subagents for tasks | No permission to spawn, but subagent's tool calls are checked |
| `AskUserQuestion` | Asks multiple-choice questions | No external effects |
| `CronCreate` | Schedules recurring/one-shot prompts | Session-scoped, restored on resume |
| `CronDelete` | Cancels scheduled task by ID | No external effects |
| `CronList` | Lists all scheduled tasks | Read-only |
| `EnterPlanMode` | Switches to plan mode | No file modifications |
| `EnterWorktree` | Creates isolated git worktree | Creates new directories only |
| `ExitWorktree` | Exits worktree session | Returns to original directory |
| `Glob` | Pattern-based file search | Already listed above |
| `Grep` | Content search | Already listed above |
| `NotebookEdit` | Modifies Jupyter notebooks | **REQUIRES PERMISSION** (see below) |
| `PushNotification` | Sends desktop notifications | Local only, no external writes |
| `RemoteTrigger` | Creates/updates Routines on claude.ai | Requires Pro+ plan, Anthropic API only |
| `SendMessage` | Messages agent teams | No external effects |
| `ShareOnboardingGuide` | Uploads and shares ONBOARDING.md | **REQUIRES PERMISSION** (see below) |
| `Skill` | Executes skill workflows | **REQUIRES PERMISSION** (see below) |
| `TaskCreate` | Creates new task in task list | Internal state only |
| `TaskGet` | Retrieves task details | Internal state only |
| `TaskList` | Lists all tasks | Read-only |
| `TaskOutput` | Retrieves output from background tasks | **DEPRECATED**, use Read instead |
| `TaskStop` | Kills running background task | Stops internal processes |
| `TaskUpdate` | Updates task status/dependencies | Internal state only |
| `TeamCreate` | Creates agent team | Internal state only |
| `TeamDelete` | Disbands agent team | Internal cleanup only |
| `TodoWrite` | Manages session task checklist | Non-interactive mode only |
| `ToolSearch` | Searches for deferred MCP tools | Read-only |

### Tools Requiring Permission (Write/Execute Capabilities)

These tools can modify files, execute commands, or make network requests. They require permission prompts in most modes and can be **dangerous** if used improperly.

| Tool | Permission Required | Risk Level | Dangerous Operations |
|------|-------------------|------------|---------------------|
| `Bash` | **Yes** | **HIGH** | Executes arbitrary shell commands, can delete files, modify system, access network |
| `PowerShell` | **Yes** | **HIGH** | Executes arbitrary PowerShell commands, similar risks to Bash |
| `Edit` | **Yes** | **MEDIUM** | Modifies existing files via string replacement |
| `Write` | **Yes** | **MEDIUM** | Creates or overwrites files entirely |
| `NotebookEdit` | **Yes** | **MEDIUM** | Modifies Jupyter notebook cells |
| `WebFetch` | **Yes** | **LOW-MEDIUM** | Fetches web content, could leak sensitive data in URLs |
| `Monitor` | **Yes** | **MEDIUM** | Runs commands in background, watches output |
| `ShareOnboardingGuide` | **Yes** | **LOW** | Uploads file to Anthropic infrastructure |
| `Skill` | **Yes** | **VARIES** | Depends on what the skill does - can invoke other tools |
| `ExitPlanMode` | **Yes** | **VARIES** | Approves plan and switches mode, enabling subsequent edits |

## Permission Modes and Tool Behavior

The permission mode controls how often prompts appear:

| Mode | Read-Only Tools | Write Tools | Bash/WebFetch | Best For |
|------|----------------|-------------|---------------|----------|
| `default` | ✅ No prompt | ⚠️ Prompts | ⚠️ Prompts | Getting started, sensitive work |
| `acceptEdits` | ✅ No prompt | ✅ Auto-approved | ⚠️ Prompts | Iterating on code you're reviewing |
| `plan` | ✅ No prompt | ❌ Blocks edits | ⚠️ Prompts for exploration | Analyzing before changing |
| `auto` | ✅ No prompt | ⚠️ Classifier decides | ⚠️ Classifier decides | Long tasks, reducing prompt fatigue |
| `dontAsk` | ✅ No prompt | ❌ Denied unless pre-approved | ❌ Denied unless pre-approved | CI/CD, locked-down environments |
| `bypassPermissions` | ✅ No prompt | ✅ No prompts | ✅ No prompts | Isolated containers/VMs only |

## Most Dangerous Tools

### 1. Bash (HIGH RISK)

**Why it's dangerous**: Can execute arbitrary shell commands that can:
- Delete files (`rm -rf`)
- Modify system configuration
- Access network resources
- Install/uninstall software
- Read sensitive files

**Safety measures**:
- Permission prompts in most modes
- Read-only commands recognized (`ls`, `cat`, `grep`, etc.)
- Compound command awareness (`&&`, `||`, `;`, `|`)
- Sandboxing support for filesystem/network isolation
- Protected paths (`.git`, `.claude`, etc.) never auto-approved for writes

**Permission rule examples**:
```json
{
  "permissions": {
    "allow": ["Bash(npm test)", "Bash(git status)"],
    "deny": ["Bash(rm -rf *)", "Bash(curl *)"]
  }
}
```

### 2. PowerShell (HIGH RISK)

**Why it's dangerous**: Similar to Bash - can execute arbitrary PowerShell commands that affect the system.

**Safety measures**: Same as Bash, with PowerShell-specific command recognition.

**Enable with**: `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`

### 3. Edit/Write (MEDIUM RISK)

**Why they're dangerous**: Can modify or overwrite any file in the working directory, potentially:
- Corrupting critical files
- Introducing bugs
- Losing work if overwriting wrong file

**Safety measures**:
- Read-before-edit requirement (must read file before editing)
- Exact string matching (no fuzzy replacements)
- Protected paths never auto-approved
- Must have read existing file before overwriting with Write

**Permission rule examples**:
```json
{
  "permissions": {
    "allow": ["Edit(/src/**)", "Write(/docs/**)"],
    "deny": ["Edit(.env)", "Write(./package.json)"]
  }
}
```

### 4. WebFetch/WebSearch (LOW-MEDIUM RISK)

**Why they're risky**: Can leak sensitive information or fetch malicious content.

**Safety measures**:
- Domain-based permission rules: `WebFetch(domain:example.com)`
- Auto-upgrade HTTP to HTTPS
- Content cached for 15 minutes
- WebSearch shows titles/URLs only, doesn't fetch pages

## Protected Paths

Writes to these paths are never auto-approved (except in `bypassPermissions` mode):

**Directories**:
- `.git` - Git repository metadata
- `.vscode` - VS Code settings
- `.idea` - JetBrains IDE settings
- `.husky` - Git hooks
- `.claude` - Claude Code configuration (except subdirs where Claude creates content)

**Files**:
- `.gitconfig`, `.gitmodules` - Git configuration
- `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile` - Shell configurations
- `.ripgreprc` - Ripgrep configuration
- `.mcp.json`, `.claude.json` - MCP and Claude configuration

## Permission Rule Syntax

### Tool-specific patterns

| Tool | Rule Format | Example |
|------|-------------|---------|
| Bash | `Bash(command pattern)` | `Bash(npm test *)` |
| PowerShell | `PowerShell(command pattern)` | `PowerShell(Get-ChildItem *)` |
| Read | `Read(path pattern)` | `Read(~/secrets/**)` |
| Edit | `Edit(path pattern)` | `Edit(/src/**/*.ts)` |
| WebFetch | `WebFetch(domain:example.com)` | `WebFetch(domain:api.github.com)` |
| Agent | `Agent(AgentName)` | `Agent(Explore)` |
| Skill | `Skill(skill name)` | `Skill(deploy *)` |

### Wildcard patterns

- `*` - Matches any sequence (including spaces)
- `**` - Matches recursively across directories
- `:*` - Equivalent to trailing ` *`
- `//path` - Absolute path from filesystem root
- `~/path` - Path from home directory
- `/path` - Path relative to project root

### Settings precedence

1. Managed settings (cannot be overridden)
2. Command line arguments
3. Local project settings (`.claude/settings.local.json`)
4. Shared project settings (`.claude/settings.json`)
5. User settings (`~/.claude/settings.json`)

## Tool-Specific Behaviors

### Bash Tool

- **Persistence**: `cd` changes persist within project directory, but environment variables do not
- **Timeout**: Default 2 minutes, max 10 minutes
- **Output length**: Default 30,000 characters, max 150,000
- **Background tasks**: Can run with `run_in_background: true`
- **Read-only commands**: Auto-approved in every mode (`ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, `diff`, `stat`, `du`, `cd`)

### Edit Tool

- **Exact matching**: Requires exact string match (no regex or fuzzy matching)
- **Read-before-edit**: Must have read file in current conversation
- **Uniqueness**: `old_string` must appear exactly once unless `replace_all: true`

### Write Tool

- **Overwrite protection**: Must have read existing file before overwriting
- **No append**: Only creates or overwrites entirely
- **New files**: No read requirement for new files

### Grep Tool

- **Built on ripgrep**: Uses ripgrep regex syntax, not POSIX grep
- **Output modes**: `files_with_matches` (default), `content`, `count`
- **Respects .gitignore**: Gitignored files skipped by default

### Glob Tool

- **Does NOT respect .gitignore**: Finds gitignored files by default
- **Sorted by mtime**: Results sorted by modification time
- **Capped at 100**: Returns max 100 files

### WebFetch Tool

- **Lossy by design**: Uses extraction prompt, may miss content
- **Auto-upgrade**: HTTP → HTTPS
- **Cached**: 15-minute cache
- **Redirect handling**: Returns redirect info instead of following

### WebSearch Tool

- **Backend search**: Uses Anthropic's web search backend
- **Up to 8 searches**: May issue multiple searches per call
- **Doesn't fetch pages**: Returns titles and URLs only
- **Provider limitation**: Not available on Amazon Bedrock

## Subagent Tool Access

Subagents inherit or restrict tool access based on their frontmatter:

| Configuration | Subagent Tools |
|---------------|----------------|
| Neither field set | Inherits all parent tools |
| `tools` only | Gets only listed tools |
| `disallowedTools` only | Gets all except listed |
| Both set | `disallowedTools` takes precedence |

**Background subagents**: Auto-deny tools that would prompt, continue without them.

**Foreground subagents**: Show same permission prompts as main conversation.

## Security Best Practices

1. **Use appropriate permission modes**: Start with `default`, use `acceptEdits` for trusted iterations
2. **Review permission rules**: Regularly check `/permissions` for what's allowed
3. **Enable sandboxing**: For Bash commands that shouldn't access system resources
4. **Protect sensitive paths**: Use deny rules for `.env`, secrets, critical configs
5. **Audit background tasks**: Check `/tasks` for long-running processes
6. **Review plans**: Use plan mode before making significant changes
7. **Avoid bypassPermissions**: Only in isolated containers/VMs
8. **Use hooks**: PreToolUse hooks can add custom permission logic
9. **Check subagent capabilities**: Review subagent frontmatter before use
10. **Monitor network access**: Review WebFetch/WebSearch domains being accessed

## See Also

- [Permissions](../claude-code/permissions.md) - Complete permission system reference
- [Permission Modes](../claude-code/permission-modes.md) - Mode switching and behavior
- [Sandboxing](../claude-code/sandboxing.md) - OS-level filesystem/network isolation
- [Hooks](../claude-code/hooks.md) - Custom permission logic via hooks
- [Subagents](../claude-code/sub-agents.md) - Configuring subagent tool access
