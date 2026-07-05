// https://github.com/SeanDishman/openai-account-generator
'use strict';
// Minimal raw-SMTP test client: sends one message to the catch-all and exits.
const net = require('net');

const HOST = process.env.H || '127.0.0.1';
const PORT = parseInt(process.env.P || '2525', 10);
const TO = process.env.TO || 'literally-anything@example.com';
const FROM = process.env.FROM || 'alerts@somebank.test';

const body = [
  `From: Some Bank <${FROM}>`,
  `To: ${TO}`,
  `Subject: Your verification code is 483920`,
  `Content-Type: text/html; charset=utf-8`,
  ``,
  `<h1>Hello 👋</h1><p>Your code is <b>483920</b>. It expires in 10 minutes.</p>`,
].join('\r\n');

const steps = [
  `HELO tester.local`,
  `MAIL FROM:<${FROM}>`,
  `RCPT TO:<${TO}>`,
  `DATA`,
  `${body}\r\n.`,
  `QUIT`,
];

const sock = net.createConnection(PORT, HOST);
let i = 0;
sock.setEncoding('utf8');
sock.on('data', (d) => {
  process.stdout.write('S: ' + d);
  if (i < steps.length) {
    const line = steps[i++];
    process.stdout.write('C: ' + line + '\n');
    sock.write(line + '\r\n');
  }
});
sock.on('close', () => console.log('--- connection closed ---'));
sock.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
