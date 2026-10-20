import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServer } from './rpc.mjs';
import { home, dataDir } from './cli.mjs';
const runtime = JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8'));
const rpc = await new AppServer(runtime.codex, home).start();
try {
  await rpc.request('config/batchWrite', {
    edits: [{
      keyPath: 'mcp_servers.goal_keeper', mergeStrategy: 'upsert', value: {
        command: runtime.node,
        args: [join(runtime.root, 'src/mcp.mjs')],
        cwd: runtime.root,
        env_vars: ['CODEX_HOME', 'CODEX_CLI_PATH', 'CODEX_THREAD_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'LOCALAPPDATA', 'PATH'],
        startup_timeout_sec: 10, tool_timeout_sec: 20,
      },
    }],
    reloadUserConfig: true,
  });
  console.log('Goal Keeper MCP runtime configured.');
} finally { rpc.close(); }
