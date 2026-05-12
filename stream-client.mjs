const GRAY = '\x1b[90m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const prompt = process.argv[2] || 'say hello in one word';

const res = await fetch('http://localhost:3000/api/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt, options: { includePartialMessages: true } }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    const match = line.match(/^data:\s*(.+)$/);
    if (!match) continue;

    const event = JSON.parse(match[1]);

    if (event.type === 'partial') {
      const sdk = JSON.parse(event.content);
      const evt = sdk.event;
      if (evt.type === 'content_block_delta') {
        const delta = evt.delta;
        if (delta.type === 'thinking_delta') {
          process.stdout.write(GRAY + delta.thinking + RESET);
        } else if (delta.type === 'text_delta') {
          process.stdout.write(delta.text);
        }
      }
    } else if (event.type === 'text') {
      try {
        const msg = JSON.parse(event.content);
        if (msg.type === 'result') {
          process.stdout.write('\n');
        }
      } catch {}
    } else if (event.type === 'error') {
      process.stderr.write(`\nError: ${event.error}\n`);
    }
  }
}

console.log();
