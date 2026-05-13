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

  // ─── Structured panel data endpoints ──────────────────────────────────────

  // GET /api/data/gameprojects — list of game projects from Obsidian/Projects
  if (pathname === '/api/data/gameprojects') {
    cors(res);
    const GAME_DIRS = ['FPS_Game_Godot','ExtractionShooter','MinecraftClone','Games','MyWebUI','Sandbox'];
    const projects = [];
    for (const dir of GAME_DIRS) {
      const full = path.join(OBSIDIAN_VAULT, 'Projects', dir);
      if (!fs.existsSync(full)) continue;
      const files = fs.readdirSync(full).filter(f => f.endsWith('.md'));
      let spec = '', plan = '';
      for (const f of files) {
        const content = fs.readFileSync(path.join(full, f), 'utf8');
        if (f.match(/SPEC|README|index/i)) spec = content.slice(0, 800);
        if (f.match(/PLAN|ROADMAP|TASK/i)) plan = content.slice(0, 600);
      }
      // Count tasks
      const allMd = files.map(f => {
        try { return fs.readFileSync(path.join(full, f), 'utf8'); } catch { return ''; }
      }).join('\n');
      const open = (allMd.match(/- \[ \]/g) || []).length;
      const done = (allMd.match(/- \[x\]/gi) || []).length;
      projects.push({ id: dir, name: dir.replace(/_/g,' '), files: files.length, spec, plan, openTasks: open, doneTasks: done });
    }
    json(res, 200, projects);
    return;
  }

  // GET /api/data/gameproject?id=FPS_Game_Godot — full project detail
  if (pathname === '/api/data/gameproject') {
    cors(res);
    const id = url.searchParams.get('id') || '';
    if (!id || id.includes('..')) { err(res, 400, 'bad id'); return; }
    const full = path.join(OBSIDIAN_VAULT, 'Projects', id);
    if (!fs.existsSync(full)) { err(res, 404, 'not found'); return; }
    const files = [];
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.md') && !f.endsWith('.gd') && !f.endsWith('.tscn') && !f.endsWith('.json')) continue;
      try {
        const content = fs.readFileSync(path.join(full, f), 'utf8');
        files.push({ name: f, content: content.slice(0, 2000) });
      } catch {}
    }
    json(res, 200, { id, files });
    return;
  }

  // GET /api/data/startup — Buizznethub overview
  if (pathname === '/api/data/startup') {
    cors(res);
    const base = path.join(OBSIDIAN_VAULT, 'Projects', 'Buizznethub');
    const readFile = (name) => {
      try { return fs.readFileSync(path.join(base, name), 'utf8'); } catch { return ''; }
    };
    const readme   = readFile('README.md');
    const roadmap  = readFile('ROADMAP.md');
    const pitch    = readFile('Pitch-Deck-Buizznethub.md');
    const business = readFile('business.md');
    const investor = readFile('investor-outreach-kanban.md');
    json(res, 200, {
      readme:   readme.slice(0, 1500),
      roadmap:  roadmap.slice(0, 2000),
      pitch:    pitch.slice(0, 1200),
      business: business.slice(0, 1200),
      investor: investor.slice(0, 1000),
    });
    return;
  }

  // ─── Jobs DB endpoints ────────────────────────────────────────────────────
  const DB_PATH = path.join(OBSIDIAN_VAULT, 'jobs.db');

  function runPy(script) {
    const { execSync } = require('child_process');
    return execSync(`python3 -c "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
  }

  // GET /api/data/jobs — all jobs from SQLite
  if (pathname === '/api/data/jobs' && req.method === 'GET') {
    cors(res);
    try {
      const result = runPy(`
import sqlite3,json
conn=sqlite3.connect('${DB_PATH}')
conn.row_factory=sqlite3.Row
cur=conn.cursor()
cur.execute('SELECT * FROM jobs ORDER BY id DESC')
print(json.dumps([dict(r) for r in cur.fetchall()]))
`);
      json(res, 200, { jobs: JSON.parse(result) });
    } catch(e) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(OBSIDIAN_VAULT,'job-applications','jobs_found.json'),'utf8'));
        json(res, 200, { jobs: j });
      } catch { json(res, 200, { jobs: [] }); }
    }
    return;
  }

  // POST /api/data/jobs — create new job row
  if (pathname === '/api/data/jobs' && req.method === 'POST') {
    cors(res);
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const result = runPy(`
import sqlite3,json
conn=sqlite3.connect('${DB_PATH}')
cur=conn.cursor()
cur.execute('INSERT INTO jobs (title,company,location,url,found_date,applied,applied_date,portal_type,notes,source,stage,salary,contact,next_step) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  [${JSON.stringify(j.title||'')},${JSON.stringify(j.company||'')},${JSON.stringify(j.location||'')},${JSON.stringify(j.url||'')},${JSON.stringify(j.found_date||new Date().toISOString().slice(0,10))},${j.applied?1:0},${JSON.stringify(j.applied_date||'')},${JSON.stringify(j.portal_type||'')},${JSON.stringify(j.notes||'')},${JSON.stringify(j.source||'manual')},${JSON.stringify(j.stage||'lead')},${JSON.stringify(j.salary||'')},${JSON.stringify(j.contact||'')},${JSON.stringify(j.next_step||'')}])
conn.commit()
print(cur.lastrowid)
`);
        json(res, 200, { id: parseInt(result) });
      } catch(e) { err(res, 500, e.message); }
    });
    return;
  }

  // PATCH /api/data/jobs/:id — update fields on a job
  if (pathname.startsWith('/api/data/jobs/') && req.method === 'PATCH') {
    cors(res);
    const jobId = parseInt(pathname.split('/').pop());
    if (isNaN(jobId)) { err(res, 400, 'bad id'); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const fields = JSON.parse(body);
        const allowed = ['title','company','location','url','found_date','applied','applied_date','portal_type','notes','source','stage','salary','contact','next_step'];
        const sets = Object.keys(fields).filter(k => allowed.includes(k));
        if (!sets.length) { json(res, 200, { ok: true }); return; }
        const setParts = sets.map(k => `${k}=?`).join(',');
        const vals = sets.map(k => fields[k]);
        runPy(`
import sqlite3
conn=sqlite3.connect('${DB_PATH}')
cur=conn.cursor()
cur.execute('UPDATE jobs SET ${setParts} WHERE id=?',${JSON.stringify([...vals, jobId])})
conn.commit()
`);
        json(res, 200, { ok: true });
      } catch(e) { err(res, 500, e.message); }
    });
    return;
  }

  // DELETE /api/data/jobs/:id
  if (pathname.startsWith('/api/data/jobs/') && req.method === 'DELETE') {
    cors(res);
    const jobId = parseInt(pathname.split('/').pop());
    if (isNaN(jobId)) { err(res, 400, 'bad id'); return; }
    try {
      runPy(`
import sqlite3
conn=sqlite3.connect('${DB_PATH}')
conn.cursor().execute('DELETE FROM jobs WHERE id=?',[${jobId}])
conn.commit()
`);
      json(res, 200, { ok: true });
    } catch(e) { err(res, 500, e.message); }
    return;
  }

  // GET /api/data/lifetoday — today's daily note + tasks + calendar
  if (pathname === '/api/data/lifetoday') {
    cors(res);
    const today = new Date().toISOString().slice(0, 10);
    const readFile = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    const dailyNote = readFile(path.join(OBSIDIAN_VAULT, 'Daily', `${today}.md`));
    const tasks     = readFile(path.join(OBSIDIAN_VAULT, 'Daily', 'TASKS.md'));
    const calendar  = readFile(path.join(OBSIDIAN_VAULT, 'Life', 'Calendar.md'));
    // Parse todos from daily note
    const parseTasks = (md) => (md || '').split('\n')
      .filter(l => /^- \[[ xX]\]/.test(l.trim()))
      .map(l => ({ done: /\[[xX]\]/.test(l), text: l.replace(/.*?\[[ xX]\]\s*/, '').trim() }));
    json(res, 200, {
      date: today,
      dailyNote: dailyNote.slice(0, 3000),
      tasks: tasks.slice(0, 2000),
      calendar: calendar.slice(0, 1500),
      todos: parseTasks(dailyNote || tasks),
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
