// Docker-free local Redis for development and tests (Windows).
// One-time setup: download Redis-x64-5.0.14.1.zip from https://github.com/tporadowski/redis/releases and unzip it into .local-redis/
// Usage: pnpm redis:local   (keeps running; Ctrl+C to stop). Listens on 6380.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const exe = '.local-redis/redis-server.exe';
const port = process.env.REDIS_PORT ?? '6380'; // 6379 is blocked on some Windows machines
if (!existsSync(exe)) {
  console.error('Redis not found. Download Redis-x64-5.0.14.1.zip from https://github.com/tporadowski/redis/releases and unzip it into .local-redis/');
  process.exit(1);
}
const child = spawn(exe, ['--port', port], { stdio: 'inherit' });
console.log(`Redis starting: redis://localhost:${port}`);
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill());
