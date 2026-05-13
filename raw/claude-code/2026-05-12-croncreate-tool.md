# CronCreate Tool Documentation

**Source**: https://docs.anthropic.com/en/docs/claude-code/scheduled-tasks  
**Collected**: 2026-05-12  
**Published**: Unknown (Documentation current as of Claude Code v2.1.72+)

---

## Overview

`CronCreate` is a scheduling tool in Claude Code that creates recurring or one-shot prompts within a session. Tasks are session-scoped and restored on `--resume` or `--continue` if unexpired. Part of the cron scheduling system alongside `CronList` and `CronDelete`.

## Tool Signature

```json
{
  "name": "CronCreate",
  "description": "Schedule a prompt to be enqueued at a future time. Supports both recurring schedules and one-shot reminders. Returns a job ID that can be used with CronDelete to cancel the task.",
  "input_schema": {
    "type": "object",
    "properties": {
      "cron": {
        "type": "string",
        "description": "Standard 5-field cron expression in local time: M H DoM Mon DoW (e.g., '*/5 * * * *' = every 5 min, '30 14 28 2 *' = Feb 28 at 2:30pm local once, recurring: false)"
      },
      "prompt": {
        "type": "string",
        "description": "The prompt to enqueue at each fire time. For autonomous loops, pass the literal sentinel '<<autonomous-loop>>' and the runtime resolves it back to the autonomous-loop instructions at fire time."
      },
      "recurring": {
        "type": "boolean",
        "description": "true (default) = fire on every cron match until deleted or auto-expiry (7 days). false = fire once at next match then auto-delete. Use false for 'remind me at X' one-shot tasks."
      },
      "durable": {
        "type": "boolean",
        "description": "true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when Claude exits. Use true only when user explicitly asks for persistence."
      }
    },
    "required": ["cron", "prompt"]
  }
}
```

## Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `cron` | string | Yes | - | 5-field cron expression (M H DoM Mon DoW) in local timezone |
| `prompt` | string | Yes | - | Prompt to execute at scheduled time. Use `<<autonomous-loop>>` for autonomous mode |
| `recurring` | boolean | No | true | true = repeats until deleted/expired; false = one-shot then auto-deletes |
| `durable` | boolean | No | false | true = persists to disk across restarts; false = session-only |

## Cron Expression Format

Standard 5-field vixie-cron syntax: `minute hour day-of-month month day-of-week`

- All fields support `*` (wildcard), single values (`5`), steps (`*/15`), ranges (`1-5`), lists (`1,15,30`)
- Day-of-week: `0` or `7` = Sunday, `1-6` = Monday-Saturday
- Local timezone interpretation (no UTC conversion)
- Extended syntax (L, W, ?, MON, JAN) **NOT** supported

### Examples

| Expression | Meaning |
|------------|---------|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour on the hour |
| `7 * * * *` | Every hour at 7 minutes past |
| `0 9 * * *` | Every day at 9am local |
| `0 9 * * 1-5` | Weekdays at 9am local |
| `30 14 28 2 *` | March 15 at 2:30pm local (one-shot if recurring=false) |
| `57 8 * * *` | Daily at 8:57am (avoids :00 jitter) |

## Usage Patterns

### Fixed Interval Scheduling

```bash
/loop 5m check if the deployment finished
```

Claude converts this to a cron expression and creates the job.

### One-Time Reminders

```text
remind me at 3pm to push the release branch
in 45 minutes, check whether the integration tests passed
```

Claude pins the fire time to specific minute/hour and sets `recurring: false`.

### Autonomous Loops (Dynamic Pacing)

```bash
/loop check whether CI passed and address any review comments
```

Omitting the interval lets Claude choose delays dynamically based on what it observes. May use Monitor tool instead of cron for efficiency.

### Built-in Maintenance Prompt

```bash
/loop
```

Runs default prompt: continues unfinished work, tends to PRs, runs cleanup passes. Can be customized with `.claude/loop.md`.

## Runtime Behavior

### Scheduling Engine

- Checks every second for due tasks
- Enqueues prompts at low priority between turns (never mid-response)
- All times in user's local timezone
- Jitter applied to avoid API thundering herd:
  - Recurring: up to 30min late (or half interval for >hourly tasks)
  - One-shot: up to 90sec early for `:00`/`:30` times

### Session Scope

- Lives in current conversation only
- Stops on new session start
- Restored on `--resume`/`--continue` if:
  - Recurring: created within last 7 days
  - One-shot: scheduled time hasn't passed
- Max 50 tasks per session

### Seven-Day Expiry

- Recurring tasks auto-delete after 7 days
- Final fire occurs before deletion
- Bounds forgotten loops; recreate for longer persistence

### Durable Tasks

- When `durable: true`: writes to `.claude/scheduled_tasks.json`
- Survives session restart (not session termination)
- Auto-deletes one-shot missed tasks on resume
- Prefer session-only (`durable: false`) for ephemeral loops

## Jitter Rules (Avoid :00 and :30)

The scheduler adds deterministic offsets:

1. **Recurring tasks**: Fire up to 30min after scheduled time (or half interval for sub-hourly)
   - Example: `0 9 * * *` may fire anywhere 9:00-9:30
   - Same ID = same offset (deterministic)
   - **Solution**: Use `3 9 * * *` (9:03am) for exact timing

2. **One-shot tasks**: `:00`/`:30` times fire up to 90sec early
   - **Solution**: Use off-minute times like `14 15` (3:14pm)

## Integration with Other Tools

| Tool | Relationship |
|------|--------------|
| `CronList` | Lists all scheduled tasks with IDs, schedules, prompts |
| `CronDelete` | Cancels task by ID returned from CronCreate |
| `Monitor` | Alternative for event-driven workflows (streams output) |
| `/loop` | Bundled skill that wraps CronCreate for common cases |
| `/goal` | For turn-by-turn loops until condition met (not interval-based) |

## Platform Limitations

| Platform | Scheduled Tasks | Notes |
|----------|----------------|-------|
| Anthropic API | Full | All features available |
| Amazon Bedrock | **NO** | Scheduled tasks unavailable |
| Google Vertex AI | Partial | Dynamic loops fall back to 10min fixed |
| Microsoft Foundry | Partial | Dynamic loops fall back to 10min fixed |

## Environment Variables

- `CLAUDE_CODE_DISABLE_CRON=1` - Disables scheduler entirely
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` - Required for agent-related scheduling

## Error Handling

- No catch-up for missed fires (single fire when Claude becomes idle)
- Background Bash/monitor tasks never restored on resume
- Invalid cron expressions cause immediate tool failure

## Best Practices

1. **Use `/loop` for quick polls** - Simpler than raw CronCreate
2. **Pick off-minute times** - Avoid jitter (e.g., `7 * * * *` not `0 * * * *`)
3. **Prefer dynamic intervals** - Let Claude choose when exact timing doesn't matter
4. **Set `recurring: false`** - For one-shot reminders to auto-cleanup
5. **Avoid durable for ephemeral loops** - Only use when explicitly requested
6. **Check with `/tasks`** - List active tasks to avoid forgotten loops
7. **Press `Esc` to stop** - Clears pending wakeup for `/loop` only

## Comparison with Alternatives

| Feature | `/loop` (CronCreate) | Routines | Desktop Tasks |
|---------|---------------------|----------|---------------|
| Scope | Session | Cloud | Local machine |
| Requires session open | Yes | No | No |
| Min interval | 1 minute | 1 hour | 1 minute |
| Persistence | Resume only | Permanent | Permanent |
| Access to local files | Yes | No (fresh clone) | Yes |
| MCP servers | Inherits | Per-task config | Config files |
| Permission prompts | Inherits | None | Configurable |

## See Also

- [Scheduled Tasks Documentation](https://docs.anthropic.com/en/docs/claude-code/scheduled-tasks)
- [Tools Reference](https://docs.anthropic.com/en/docs/claude-code/tools-reference)
- [Routines](https://docs.anthropic.com/en/docs/claude-code/routines)
- [Desktop Scheduled Tasks](https://docs.anthropic.com/en/docs/claude-code/desktop-scheduled-tasks)
