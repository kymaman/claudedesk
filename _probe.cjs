/* global Buffer, setTimeout, console */
/* eslint-disable no-empty */
const pty = require('node-pty');
const bin = process.argv[2];
let bytes = [];
let saw = false;
const p = pty.spawn(bin, [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: process.env.USERPROFILE,
});
p.onData((d) => {
  const b = Buffer.from(d, 'utf8');
  bytes.push(b);
  if (
    Buffer.concat(bytes)
      .toString('binary')
      .indexOf(String.fromCharCode(27) + '[?1049h') >= 0
  )
    saw = true;
});
setTimeout(() => {
  const all = Buffer.concat(bytes);
  console.log('TOTAL_BYTES', all.length);
  console.log('SAW_1049h', saw);
  const seqs = [];
  const re = new RegExp(String.fromCharCode(27) + '\\\\[\\\\?[0-9;]+[hl]', 'g');
  let m;
  const t = all.toString('binary');
  while ((m = re.exec(t)) && seqs.length < 20) seqs.push(JSON.stringify(m[0]));
  console.log('MODES', seqs.join(' '));
  try {
    p.kill();
  } catch {}
  process.exit(0);
}, 5000);
