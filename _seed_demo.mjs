import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── env ──
const env = {};
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const SYSTEM_ID = 'f2287199-cb6a-4829-8675-88200351c813';
const BOARD_ID = '78cf4d4e-1fe9-4892-9df4-f215ae788763';
const MANAGER_ID = '46cd96c3-0ea4-4e7f-868c-3597fb1b200c';
const DEMO_DOMAIN = '@smartshift.local';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── 1. cleanup previous demo data (repeatable) ──
console.log('cleanup…');
await db.from('assignments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
await db.from('constraints').delete().neq('id', '00000000-0000-0000-0000-000000000000');
await db.from('shifts').delete().eq('board_id', BOARD_ID);
await db.from('workers').delete().is('user_id', null).eq('system_id', SYSTEM_ID); // standalone only

// delete previous demo auth users (+ their profile/worker)
const { data: userList } = await db.auth.admin.listUsers({ perPage: 200 });
for (const u of userList?.users ?? []) {
  if (u.email && u.email.endsWith(DEMO_DOMAIN)) {
    await db.from('workers').delete().eq('id', u.id);
    await db.from('profiles').delete().eq('id', u.id);
    await db.auth.admin.deleteUser(u.id);
  }
}

// ── 2. registered workers (auth user + profile + worker) ──
const registered = [
  { full_name: 'דניאל כהן', reserves: false },
  { full_name: 'נועה לוי', reserves: false },
  { full_name: 'איתי מזרחי', reserves: true },
  { full_name: 'יעל אברהם', reserves: false },
  { full_name: 'עומר פרץ', reserves: false },
  { full_name: 'מאיה ביטון', reserves: false },
];

const workerIds = []; // all assignable worker ids
const registeredIds = {}; // name -> id (for constraints)

console.log('creating registered workers…');
let idx = 0;
for (const r of registered) {
  idx++;
  const email = `demo.w${idx}${DEMO_DOMAIN}`;
  const { data: created, error: authErr } = await db.auth.admin.createUser({
    email,
    password: 'Demo1234!',
    email_confirm: true,
    user_metadata: { full_name: r.full_name },
  });
  if (authErr) { console.log('  auth err', email, authErr.message); continue; }
  const uid = created.user.id;
  await db.from('profiles').insert({
    id: uid, full_name: r.full_name, email, role: 'worker',
    system_id: SYSTEM_ID, is_reserves: r.reserves,
  });
  await db.from('workers').insert({
    id: uid, full_name: r.full_name, email, user_id: uid,
    system_id: SYSTEM_ID, is_reserves: r.reserves,
  });
  workerIds.push(uid);
  registeredIds[r.full_name] = uid;
  console.log('  +', r.full_name);
}

// ── 3. standalone workers (no account) ──
const standalone = [
  { full_name: 'רון שפירא', reserves: true },
  { full_name: 'תמר גולן', reserves: false },
  { full_name: 'אלכס וולף', reserves: false },
  { full_name: 'ליאור נחמיאס', reserves: false },
];
console.log('creating standalone workers…');
for (const s of standalone) {
  const { data, error } = await db.from('workers').insert({
    full_name: s.full_name, email: null, user_id: null,
    system_id: SYSTEM_ID, is_reserves: s.reserves,
  }).select('id').single();
  if (error) { console.log('  err', s.full_name, error.message); continue; }
  workerIds.push(data.id);
  console.log('  +', s.full_name);
}

// include the manager as assignable too
workerIds.push(MANAGER_ID);

// ── 4. shifts: today-7 … today+14, day + night ──
console.log('creating shifts…');
const today = new Date();
today.setHours(0, 0, 0, 0);
const start = new Date(today); start.setDate(start.getDate() - 7);
const end = new Date(today); end.setDate(end.getDate() + 14);

const shiftRows = [];
for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
  for (const type of ['day', 'night']) {
    shiftRows.push({ date: ymd(d), type, board_id: BOARD_ID, created_by: MANAGER_ID, required_count: 1 });
  }
}
const { data: shifts, error: shiftErr } = await db.from('shifts').insert(shiftRows).select('id, date, type');
if (shiftErr) { console.log('shift err', shiftErr.message); process.exit(1); }
console.log('  shifts:', shifts.length);

// ── 5. assignments: fill ~75%, balance load, no same-day double ──
console.log('creating assignments…');
const load = Object.fromEntries(workerIds.map((w) => [w, 0]));
const perDay = {}; // `${date}` -> Set(workerId)
const sortedShifts = [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
const asgRows = [];
let n = 0;
for (const s of sortedShifts) {
  n++;
  if (n % 4 === 0) continue; // leave ~25% empty (red)
  perDay[s.date] ??= new Set();
  const candidates = workerIds
    .filter((w) => !perDay[s.date].has(w))
    .sort((a, b) => load[a] - load[b]);
  const chosen = candidates[0];
  if (!chosen) continue;
  asgRows.push({ shift_id: s.id, worker_id: chosen });
  load[chosen]++;
  perDay[s.date].add(chosen);
}
const { error: asgErr } = await db.from('assignments').insert(asgRows);
if (asgErr) { console.log('asg err', asgErr.message); } else console.log('  assignments:', asgRows.length);

// ── 6. constraints (need profiles → use registered workers) ──
console.log('creating constraints…');
const d = (offset) => { const x = new Date(today); x.setDate(x.getDate() + offset); return ymd(x); };
const cRows = [];
if (registeredIds['דניאל כהן']) {
  cRows.push({ worker_id: registeredIds['דניאל כהן'], date: d(1), type: 'night', status: 'unavailable', note: 'אילוץ משפחתי' });
  cRows.push({ worker_id: registeredIds['דניאל כהן'], date: d(2), type: 'night', status: 'unavailable', note: null });
}
if (registeredIds['נועה לוי']) {
  cRows.push({ worker_id: registeredIds['נועה לוי'], date: d(3), type: 'day', status: 'partial', note: 'פנויה מ-12:00' });
}
if (registeredIds['יעל אברהם']) {
  cRows.push({ worker_id: registeredIds['יעל אברהם'], date: d(4), type: 'day', status: 'unavailable', note: 'לימודים' });
  cRows.push({ worker_id: registeredIds['יעל אברהם'], date: d(4), type: 'night', status: 'unavailable', note: 'לימודים' });
}
// recurring-style group for עומר: next 4 same weekday
if (registeredIds['עומר פרץ']) {
  const groupId = crypto.randomUUID();
  for (let k = 0; k < 4; k++) {
    cRows.push({ worker_id: registeredIds['עומר פרץ'], date: d(5 + k * 7), type: 'night', status: 'unavailable', note: 'קבוע', recurring_group_id: groupId });
  }
}
const { error: cErr } = await db.from('constraints').insert(cRows);
if (cErr) { console.log('constraint err', cErr.message); } else console.log('  constraints:', cRows.length);

console.log('\n✅ DONE. workers:', workerIds.length, '| shifts:', shifts.length, '| assignments:', asgRows.length, '| constraints:', cRows.length);
