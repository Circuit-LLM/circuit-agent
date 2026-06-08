// lib/tools/builder.js — file system and script execution tool definitions and handlers
// Tools: read_file, list_files, write_file, run_script, install_package, bash
'use strict';

const fs   = require('fs');
const path = require('path');

const AGENT_ROOT  = path.resolve(__dirname, '../..');
const HOME_ROOT   = require('os').homedir();  // deploying user's home directory

// Files the LLM can never overwrite (core runtime + secrets + hot-reload vectors)
const BLOCKED_WRITE = [
  '.env',
  'lib/swap.js', 'lib/wallet.js', 'lib/circuit.js', 'lib/processor.js', 'lib/memory.js',
  // Hot-reload attack vectors: processor.js reads these fresh on every LLM call.
  // Overwriting agent.local.json redirects llm.baseUrl to an attacker server.
  // Overwriting soul.local.md / system-prompt.md injects persistent system-prompt text.
  'config/agent.local.json', 'soul.local.md', 'config/system-prompt.md',
];

// Files the LLM can never run directly
const BLOCKED_RUN = ['lib/swap.js', 'lib/wallet.js', 'agent.js'];

// Files the LLM can never read
const BLOCKED_READ = ['.env', '.env.local', '.env.production'];

// Sensitive home-directory trees that must not be readable even though read_file
// allows cross-repo access to the rest of HOME_ROOT (e.g. ~/circuit-node/).
// Checked as path prefixes relative to HOME_ROOT.
const BLOCKED_READ_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.config/gcloud'];

// Bash command patterns that are always blocked (destructive/irreversible)
const BLOCKED_BASH = [
  /rm\s+-rf\s+\/(?!\s)/,               // rm -rf / (root wipe)
  />\s*\/etc\//,                        // overwrite /etc/ files
  /chmod\s+777\s+\/(?!\s)/,             // chmod 777 /
  /curl.*\|\s*(bash|sh|zsh)/,           // pipe-to-shell from internet
  // Block shell writes to critical runtime + secret files
  /(?:>|tee\s+).*(?:\.env\b|lib\/(?:swap|wallet|circuit|processor|memory)\.js)/,
  /sed\s+.*-i.*(?:\.env\b|lib\/(?:swap|wallet|circuit|processor|memory)\.js)/,
  // Block reading .env* files from disk — secrets are stripped from the child process env
  // but the file itself is still on disk and readable via shell file-reading commands.
  // Covers .env, .env.local, .env.production, etc.
  /\b(?:cat|less|more|head|tail|bat|nano|vi|vim)\b[^|]*\.env/,
  /\bgrep\b[^|]*\.env/,               // grep for keys inside .env*
];

const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read any file under the user home directory. Accepts absolute paths (e.g. ~/circuit-node/api/routes/trending.js) or relative paths within the agent dir. Always read before writing.',
      parameters: {
        type: 'object',
        properties: {
          path:   { type: 'string', description: 'Absolute path (e.g. ~/circuit-node/api/routes/trending.js) or relative path within agent dir (e.g. lib/tools/builder.js)' },
          lines:  { type: 'number', description: 'Max lines to return (default 300)' },
          offset: { type: 'number', description: 'Line number to start from (default 1)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories within the agent directory. Use to explore the project structure before building or modifying things.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to list (default: . = agent root)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write any file under the user home directory. Accepts absolute paths (e.g. ~/circuit-node/api/routes/newroute.js) or relative paths within the agent dir. ALWAYS: (1) read existing files before overwriting, (2) never overwrite .env or core lib files.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Absolute path (e.g. ~/circuit-data-api/routes/foo.js) or relative path within agent dir' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_script',
      description: 'Run a Node.js script in the agent directory. Use to test new code you have written, run utilities, or execute scripts. Always test with a --dry-run arg first if the script supports it. Returns stdout and stderr. Timeout: 30s default.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Relative path to the script (e.g. scripts/morning_report.js, lib/strategies/yield.js)' },
          args:    { type: 'array',  items: { type: 'string' }, description: 'Command-line arguments (e.g. ["--dry-run", "--limit", "5"])' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a bash shell command on the VPS. Use for build tasks: edit files with sed/awk, run scripts outside the agent dir, restart services, check logs, run git commands, curl APIs, install system packages. Working directory defaults to the user home directory. Returns stdout + stderr. Timeout: 60s default (max 300s). NEVER use for: rm -rf /, piping from internet to bash, or overwriting /etc/ files.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run. Supports pipes, redirects, &&, semicolons. Use absolute paths for clarity.' },
          cwd:     { type: 'string', description: 'Working directory (default: ~). E.g. ~/circuit-node, ~/my-project' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 60000, max 300000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_package',
      description: 'Install an npm package into the agent directory. Use when building strategies that need external SDKs — e.g. @marinade.finance/marinade-ts-sdk for yield farming, @orca-so/whirlpools-sdk for LP strategies, axios for HTTP calls. Always tell the user what you are installing and why before running this.',
      parameters: {
        type: 'object',
        properties: {
          package: { type: 'string', description: 'Package name with optional version (e.g. "@marinade.finance/marinade-ts-sdk", "axios@1.6.0")' },
        },
        required: ['package'],
      },
    },
  },
];

const HANDLERS = {
  async read_file(args, _ctx, _log) {
    // Support absolute paths under HOME_ROOT, or relative paths from agent dir
    const inputPath = args.path ?? '';
    const target = inputPath.startsWith('/') ? path.resolve(inputPath) : path.resolve(AGENT_ROOT, inputPath);
    if (!target.startsWith(HOME_ROOT + path.sep) && target !== HOME_ROOT) {
      return JSON.stringify({ error: `Path must be within ${HOME_ROOT}/` });
    }
    const rel      = path.relative(AGENT_ROOT, target);
    const basename = path.basename(target);
    if (BLOCKED_READ.includes(rel) || rel.startsWith('.env') ||
        basename.startsWith('.env') || BLOCKED_READ.includes(basename)) {
      return JSON.stringify({ error: 'Cannot read secrets file — it contains private keys and API tokens.' });
    }
    // Block sensitive home-directory trees (SSH keys, cloud credentials, GPG keys, etc.)
    // Cross-repo reads (~/circuit-node/, ~/circuit-data-api/, etc.) remain allowed.
    const relToHome = path.relative(HOME_ROOT, target);
    if (BLOCKED_READ_DIRS.some(d => relToHome === d || relToHome.startsWith(d + path.sep))) {
      return JSON.stringify({ error: 'Cannot read security-sensitive directory.' });
    }
    if (!fs.existsSync(target)) return JSON.stringify({ error: `File not found: ${args.path}` });
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return JSON.stringify({ error: `${args.path} is a directory — use list_files instead` });

    const allLines = fs.readFileSync(target, 'utf8').split('\n');
    const offset   = Math.max(0, (args.offset ?? 1) - 1);
    const limit    = args.lines ?? 300;
    const slice    = allLines.slice(offset, offset + limit);
    return JSON.stringify({
      path:       rel,
      totalLines: allLines.length,
      shown:      `${offset + 1}–${offset + slice.length}`,
      content:    slice.join('\n'),
    });
  },

  async list_files(args, _ctx, _log) {
    const target = path.resolve(AGENT_ROOT, args.path ?? '.');
    if (!target.startsWith(AGENT_ROOT + path.sep) && target !== AGENT_ROOT) {
      return JSON.stringify({ error: 'Path must be within the agent directory' });
    }
    if (!fs.existsSync(target)) return JSON.stringify({ error: `Path not found: ${args.path}` });

    const entries = fs.readdirSync(target).map(name => {
      const full = path.join(target, name);
      const s    = fs.statSync(full);
      return { name, type: s.isDirectory() ? 'dir' : 'file', size: s.isFile() ? s.size : null };
    });
    return JSON.stringify({ path: path.relative(AGENT_ROOT, target) || '.', entries });
  },

  async write_file(args, _ctx, log) {
    const inputPath = args.path ?? '';
    const target = inputPath.startsWith('/') ? path.resolve(inputPath) : path.resolve(AGENT_ROOT, inputPath);
    if (!target.startsWith(HOME_ROOT + path.sep)) {
      return JSON.stringify({ error: `Path must be within ${HOME_ROOT}/` });
    }
    const rel = path.relative(AGENT_ROOT, target);
    if (BLOCKED_WRITE.includes(rel) || /^\.env/.test(path.basename(target))) {
      return JSON.stringify({ error: `Cannot overwrite safety-critical file: ${path.basename(target)}` });
    }

    const content = args.content ?? '';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    log('info', `Tool: write_file ${rel}`, { bytes: content.length });
    return JSON.stringify({ written: true, path: rel, bytes: content.length, lines: content.split('\n').length });
  },

  async run_script(args, _ctx, log) {
    const { spawnSync } = require('child_process');
    const target = path.resolve(AGENT_ROOT, args.path ?? '');
    const rel    = path.relative(AGENT_ROOT, target);

    if (!target.startsWith(AGENT_ROOT + path.sep)) {
      return JSON.stringify({ error: 'Path must be within the agent directory' });
    }
    if (!fs.existsSync(target)) {
      return JSON.stringify({ error: `Script not found: ${rel}` });
    }
    if (BLOCKED_RUN.includes(rel)) {
      return JSON.stringify({ error: `Cannot run core runtime file: ${rel}` });
    }

    const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const timeout    = Math.min(args.timeout ?? 30_000, 120_000);
    log('info', `Tool: run_script ${rel}`, { args: scriptArgs, timeout });

    // Strip signing keys, auth tokens, and API-key-bearing URLs from child process env.
    // CIRCUIT_RPC_URL contains the Helius API key embedded in the URL string — strip it.
    const {
      AGENT_KEYPAIR, TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY,
      CIRCUIT_INTERNAL_KEY, JUPITER_API_KEY,
      CIRCUIT_RPC_URL, HELIUS_RPC_URL,
      ...safeEnv
    } = process.env;

    const result = spawnSync('node', [target, ...scriptArgs], {
      cwd:       AGENT_ROOT,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding:  'utf8',
      env:       safeEnv,
    });

    return JSON.stringify({
      exitCode: result.status,
      stdout:   (result.stdout ?? '').slice(0, 8000),
      stderr:   (result.stderr ?? '').slice(0, 3000),
      timedOut: result.signal === 'SIGTERM',
      signal:   result.signal ?? null,
    });
  },

  async bash(args, _ctx, log) {
    const { spawnSync } = require('child_process');
    const command = (args.command ?? '').trim();
    if (!command) return JSON.stringify({ error: 'command required' });

    // Safety: block destructive patterns
    for (const pattern of BLOCKED_BASH) {
      if (pattern.test(command)) {
        return JSON.stringify({ error: `Command blocked by safety filter: ${pattern}` });
      }
    }

    const cwd     = args.cwd || HOME_ROOT;
    const timeout = Math.min(args.timeout ?? 60_000, 300_000);
    log('info', `Tool: bash`, { command: command.slice(0, 120), cwd });

    // Inherit env (user wants full build capability) but strip all auth secrets.
    // Must match the strip list in run_script above.
    const {
      AGENT_KEYPAIR, OPENROUTER_API_KEY,
      TELEGRAM_BOT_TOKEN, CIRCUIT_INTERNAL_KEY, JUPITER_API_KEY,
      CIRCUIT_RPC_URL, HELIUS_RPC_URL,
      ...safeEnv
    } = process.env;

    const result = spawnSync('bash', ['-c', command], {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding:  'utf8',
      env:       { ...safeEnv, HOME: HOME_ROOT },
    });

    const out = {
      exitCode: result.status,
      stdout:   (result.stdout ?? '').slice(0, 10_000),
      stderr:   (result.stderr ?? '').slice(0, 3_000),
      timedOut: result.signal === 'SIGTERM',
    };
    if (result.error) out.error = result.error.message;
    return JSON.stringify(out);
  },

  async install_package(args, _ctx, log) {
    const { spawnSync } = require('child_process');
    const pkg = (args.package ?? '').trim();
    if (!pkg) return JSON.stringify({ error: 'package name required' });

    // Allow: @scope/name[@version] or name[@version]
    // Reject: ./local, ../sibling, /absolute, bare slashes in unscoped names
    if (!/^(@[a-zA-Z0-9._\-]+\/[a-zA-Z0-9._\-]+|[a-zA-Z0-9][a-zA-Z0-9._\-]*)(@[\w.\-^~>=<*|]+)?$/.test(pkg)) {
      return JSON.stringify({ error: 'Invalid package name — local paths and non-npm names are not allowed' });
    }

    log('info', `Tool: install_package ${pkg}`);

    const result = spawnSync('npm', ['install', pkg], {
      cwd:       AGENT_ROOT,
      timeout:   120_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding:  'utf8',
    });

    return JSON.stringify({
      package:  pkg,
      success:  result.status === 0,
      exitCode: result.status,
      stdout:   (result.stdout ?? '').slice(0, 3000),
      stderr:   (result.stderr ?? '').slice(0, 2000),
    });
  },
};

module.exports = { DEFINITIONS, HANDLERS };
