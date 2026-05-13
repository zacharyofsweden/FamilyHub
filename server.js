/**
 * FamilyHub local server
 * - Serves index.html
 * - /api/obsidian/**  →  reads Obsidian vault files
 * - /api/tts          →  proxies Kokoro TTS (localhost:5002)
 * - /api/hermes/chat  →  proxies to Hermes agent (localhost:3000/api/send-stream)
 * - /api/hermes/status → checks if Hermes is reachable
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = 7890;
const OBSIDIAN_VAULT = path.join(process.env.HOME, 'Documents/Obsidian');
const KOKORO_URL = 'http://localhost:5002/v1/audio/speech';
const HERMES_URL = 'http://localhost:3000';

// Map FamilyHub agent IDs to Hermes model strings
const AGENT_MODELS = {
  yuki:   'ollama_cloud/gemma4:31b',
  iris:   'google-gemini-cli/gemini-2.5-flash-preview-05-20',
  ren:    'llama_cpp/qwen3.6-35b-a3b',
  mira:   'ollama_cloud/qwen3.5:397b',
  tilda:  'ollama_cloud/gemma4:31b',
  hollis: 'google-gemini-cli/gemini-2.5-flash-preview-05-20',
  june:   'google-gemini-cli/gemini-2.5-flash-preview-05-20',
  kai:    'ollama_cloud/gemma4:31b',
  ada:    'llama_cpp/Qwen3.6.gguf',
  argus:  'ollama_cloud/qwen3.5:397b',
};

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.webm': 'audio/webm',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function err(res, code, msg) {
  json(res, code, { error: msg });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // OPTIONS preflight
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ─── Hermes status check ───────────────────────────────────────────────────
  if (pathname === '/api/hermes/status') {
    cors(res);
    try {
      const r = await new Promise((resolve, reject) => {
        const req2 = http.get(`${HERMES_URL}/api/gateway-status`, resolve);
        req2.on('error', reject);
        req2.setTimeout(2000, () => { req2.destroy(); reject(new Error('timeout')); });
      });
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => {
        try { json(res, 200, { online: true, ...JSON.parse(body) }); }
        catch { json(res, 200, { online: true }); }
      });
    } catch (e) {
      json(res, 200, { online: false, error: e.message });
    }
    return;
  }

  // ─── Hermes chat proxy (SSE passthrough) ──────────────────────────────────
  if (pathname === '/api/hermes/chat' && req.method === 'POST') {
    cors(res);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { err(res, 400, 'bad json'); return; }

      const agentId = payload.agentId || 'yuki';
      const sessionKey = `familyhub-${agentId}`;
      const model = AGENT_MODELS[agentId] || AGENT_MODELS.yuki;
      const isNewSession = payload.isNew === true;

      // Build history: inject persona as system message on first turn
      const history = [];
      if (payload.persona) {
        history.push({ role: 'system', content: payload.persona });
      }
      if (payload.history && Array.isArray(payload.history)) {
        history.push(...payload.history);
      }

      const hermesBody = JSON.stringify({
        message: payload.message || '',
        sessionKey,
        model,
        history: history.length ? history : undefined,
      });

      const hermesReq = http.request(`${HERMES_URL}/api/send-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(hermesBody),
        },
      }, hermesRes => {
        // SSE passthrough
        res.writeHead(hermesRes.statusCode, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        hermesRes.pipe(res);
      });
      hermesReq.on('error', e => {
        err(res, 502, 'hermes unavailable: ' + e.message);
      });
      hermesReq.write(hermesBody);
      hermesReq.end();
    });
    return;
  }

  // ─── Obsidian API ─────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/obsidian')) {
    cors(res);

    // GET /api/obsidian/list?dir=Projects/FPS_Game_Godot
    if (pathname === '/api/obsidian/list') {
      const dir = url.searchParams.get('dir') || '';
      const target = path.join(OBSIDIAN_VAULT, dir);
      // Security: must stay inside vault
      if (!target.startsWith(OBSIDIAN_VAULT)) { err(res, 403, 'forbidden'); return; }
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true });
        json(res, 200, entries.map(e => ({ name: e.name, isDir: e.isDirectory() })));
      } catch (e) {
        err(res, 404, e.message);
      }
      return;
    }

    // GET /api/obsidian/read?file=Daily/2026-05-13.md
    if (pathname === '/api/obsidian/read') {
      const file = url.searchParams.get('file') || '';
      const target = path.join(OBSIDIAN_VAULT, file);
      if (!target.startsWith(OBSIDIAN_VAULT)) { err(res, 403, 'forbidden'); return; }
      try {
        const content = fs.readFileSync(target, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(content);
      } catch (e) {
        err(res, 404, e.message);
      }
      return;
    }

    // GET /api/obsidian/search?q=keyword
    if (pathname === '/api/obsidian/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const results = [];
      function walk(dir) {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
            else if (e.name.endsWith('.md')) {
              try {
                const content = fs.readFileSync(full, 'utf8');
                if (content.toLowerCase().includes(q)) {
                  results.push({
                    file: path.relative(OBSIDIAN_VAULT, full),
                    snippet: content.slice(0, 200),
                  });
                }
              } catch {}
            }
          }
        } catch {}
      }
      walk(OBSIDIAN_VAULT);
      json(res, 200, results.slice(0, 30));
      return;
    }

    // GET /api/obsidian/recent  — last 5 modified .md files
    if (pathname === '/api/obsidian/recent') {
      const files = [];
      function walk(dir) {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
            else if (e.name.endsWith('.md')) {
              try { files.push({ file: path.relative(OBSIDIAN_VAULT, full), mtime: fs.statSync(full).mtimeMs }); }
              catch {}
            }
          }
        } catch {}
      }
      walk(OBSIDIAN_VAULT);
      files.sort((a,b) => b.mtime - a.mtime);
      json(res, 200, files.slice(0, 20));
      return;
    }

    err(res, 404, 'unknown endpoint');
    return;
  }

  // ─── Kokoro TTS proxy ─────────────────────────────────────────────────────
  if (pathname === '/api/tts' && req.method === 'POST') {
    cors(res);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { err(res, 400, 'bad json'); return; }

      const kokoroReq = http.request(KOKORO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, kokoroRes => {
        res.writeHead(kokoroRes.statusCode, {
          'Content-Type': kokoroRes.headers['content-type'] || 'audio/mpeg',
          'Access-Control-Allow-Origin': '*',
        });
        kokoroRes.pipe(res);
      });
      kokoroReq.on('error', e => {
        err(res, 502, 'kokoro unavailable: ' + e.message);
      });
      kokoroReq.write(JSON.stringify({
        input: payload.input || '',
        voice: payload.voice || 'af_heart',
        speed: payload.speed || 1.0,
        response_format: 'mp3',
      }));
      kokoroReq.end();
    });
    return;
  }

  // ─── Static files ─────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  // Security: stay inside FamilyHub directory
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('forbidden'); return; }

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 not found: ' + pathname);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FamilyHub running at http://localhost:${PORT}`);
  console.log(`Obsidian vault: ${OBSIDIAN_VAULT}`);
  console.log(`Kokoro TTS proxy: ${KOKORO_URL}`);
});
