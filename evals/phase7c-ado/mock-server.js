'use strict';

const http = require('node:http');
const { items } = require('../phase7b-ado/mock-server.js');
const checkoutStory = { id: 710, fields: {
  'System.WorkItemType': 'User Story', 'System.Title': 'Complete mock checkout', 'System.State': 'Active',
  'System.AreaPath': 'MockProject\\QA', 'System.IterationPath': 'MockProject\\Sprint 1',
}, relations: [] };

const requests = [];
const bugs = new Map();
const attachments = new Map();
let nextBug = 9001;
let nextAttachment = 1;
const faults = { parent: null, attachment: null, create: null, link: null, repro: null };
const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};
const fields = { value: [
  { referenceName: 'System.Title' }, { referenceName: 'System.AreaPath' },
  { referenceName: 'System.IterationPath' }, { referenceName: 'System.AssignedTo' },
  { referenceName: 'Microsoft.VSTS.Common.Severity', allowedValues: ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] },
  { referenceName: 'Microsoft.VSTS.Common.Priority', allowedValues: ['1', '2', '3', '4'] },
  { referenceName: 'Microsoft.VSTS.Common.ValueArea', allowedValues: ['Business'] },
  { referenceName: 'Microsoft.VSTS.TCM.ReproSteps' },
] };

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/audit') return send(res, 200, { requests, bugs: [...bugs.values()], attachments: [...attachments.values()] });
    if (url.pathname === '/control' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const cfg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (cfg.reset) { requests.length = 0; bugs.clear(); attachments.clear(); nextBug = 9001; nextAttachment = 1; Object.keys(faults).forEach((k) => { faults[k] = null; }); }
      if (cfg.faults) Object.assign(faults, cfg.faults);
      return send(res, 200, { ok: true });
    }
    const safe = { method: req.method, path: url.pathname, validationOnly: url.searchParams.get('validateOnly') === 'true', resultingId: null };
    requests.push(safe);
    const path = url.pathname;
    const fail = (kind) => {
      const fault = faults[kind];
      if (!fault) return false;
      if (fault === 'drop') { req.socket.destroy(); return true; }
      send(res, Number(fault), { message: `mock ${kind} error` }); return true;
    };
    const work = path.match(/^\/MockProject\/_apis\/wit\/workitems\/(\d+)$/i);
    if (work && req.method === 'GET') {
      const id = Number(work[1]);
      if (id === 710 && faults.parent) return send(res, Number(faults.parent), { message: 'parent unavailable' });
      if (id === 705) return send(res, 401, { message: `unauthorized ${req.headers.authorization || ''}` });
      if (id === 706) return send(res, 403, { message: 'permission denied' });
      if (id === 707) return send(res, 429, { message: 'rate limited' });
      if (id === 708) return send(res, 500, { message: 'backend error' });
      const item = id === 710 ? checkoutStory : (items.get(id) || bugs.get(id));
      return send(res, item ? 200 : 404, item || { message: 'not found' });
    }
    if (path === '/MockProject/_apis/wit/workitemtypes/Bug/fields' && req.method === 'GET') return send(res, 200, fields);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (path === '/MockProject/_apis/wit/wiql' && req.method === 'POST') {
      const query = JSON.parse(raw.toString('utf8')).query;
      const title = query.match(/\[System\.Title\]='((?:[^']|'')*)'/)?.[1]?.replace(/''/g, "'");
      return send(res, 200, { workItems: [...bugs.values()].filter((b) => b.fields['System.Title'] === title).map((b) => ({ id: b.id })) });
    }
    if (path === '/MockProject/_apis/wit/workitems/$Bug' && req.method === 'POST') {
      if (safe.validationOnly) return send(res, 200, { id: null });
      if (faults.create && faults.create !== 'persist-drop' && fail('create')) return;
      const ops = JSON.parse(raw.toString('utf8'));
      const id = nextBug++;
      const bug = { id, fields: { 'System.WorkItemType': 'Bug' }, relations: [] };
      for (const op of ops) if (op.path.startsWith('/fields/')) bug.fields[op.path.slice(8)] = op.value;
      bugs.set(id, bug); safe.resultingId = id;
      if (faults.create === 'persist-drop') { req.socket.destroy(); return; }
      return send(res, 200, { id, url: `http://${req.headers.host}/MockProject/_workitems/edit/${id}` });
    }
    if (path === '/MockProject/_apis/wit/attachments' && req.method === 'POST') {
      if (fail('attachment')) return;
      const id = `att-${nextAttachment++}`;
      const attachment = { id, name: url.searchParams.get('fileName'), bytes: raw.length, url: `http://${req.headers.host}/attachment/${id}` };
      attachments.set(id, attachment); safe.resultingId = id;
      return send(res, 200, attachment);
    }
    if (work && req.method === 'PATCH') {
      const id = Number(work[1]); const bug = bugs.get(id);
      if (!bug) return send(res, 404, { message: 'bug not found' });
      const ops = JSON.parse(raw.toString('utf8'));
      const kind = ops.some((o) => o.value?.rel === 'System.LinkTypes.Hierarchy-Reverse') ? 'link' : 'repro';
      if (fail(kind)) return;
      for (const op of ops) {
        if (op.path.startsWith('/fields/')) bug.fields[op.path.slice(8)] = op.value;
        if (op.path === '/relations/-') bug.relations.push(op.value);
      }
      safe.resultingId = id;
      return send(res, 200, { id, rev: 2 });
    }
    send(res, 404, { message: 'mock route not found' });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] || 12748);
  createServer().listen(port, '127.0.0.1', () => console.log(`Phase 7C ADO mock listening on 127.0.0.1:${port}`));
}

module.exports = { createServer, requests, bugs, attachments, faults };
