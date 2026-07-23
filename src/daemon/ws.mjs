// Hand-rolled, zero-dependency RFC6455 server side (M6). Node's http `upgrade` event hands us
// the raw socket after the request line/headers; we finish the handshake (SHA-1 accept key) and
// frame text/binary/ping/pong/close ourselves. Client→server frames are ALWAYS masked (spec §5.3)
// and we unmask them; server→client frames are never masked. Only what the watch channel needs:
// small JSON text in, JPEG binary out, automatic pong, clean close. No extensions, no compression.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_SEND_BACKLOG = 8 * 1024 * 1024; // drop frames to a stalled watcher rather than grow unbounded

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one server→client frame (FIN set, unmasked). */
function encode(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * One live WebSocket connection. Events: 'message' (Buffer, isBinary:bool), 'close'.
 * `.sendText(str)` / `.sendBinary(buf)` / `.close(code)`.
 */
export class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this._closed = false;
    this._fragOp = 0;         // opcode of an in-progress fragmented message (0 = none)
    this._fragParts = [];
    socket.setTimeout(0);
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => { this._buf = Buffer.concat([this._buf, chunk]); this._parse(); });
    socket.on('close', () => this._onClose());
    socket.on('error', () => this._onClose());
  }

  _feed(head) { if (head && head.length) { this._buf = Buffer.concat([this._buf, head]); this._parse(); } }

  _parse() {
    let buf = this._buf;
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) break; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buf.length < off + 8) break; len = Number(buf.readBigUInt64BE(off)); off += 8; }
      if (masked) { if (buf.length < off + 4) break; }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) break; // frame not fully arrived yet
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else if (opcode !== OP.CLOSE) {
        // spec §5.1: an unmasked client frame is a protocol error — close and stop.
        buf = Buffer.alloc(0); this.close(1002); break;
      }
      buf = buf.subarray(off + len);
      this._frame(fin, opcode, Buffer.from(payload));
    }
    this._buf = buf;
  }

  _frame(fin, opcode, payload) {
    if (opcode === OP.CLOSE) { this.close(1000); return; }
    if (opcode === OP.PING) { this._write(OP.PONG, payload); return; }
    if (opcode === OP.PONG) return;
    // data frame (text/binary) or a continuation of one
    if (opcode === OP.CONT) this._fragParts.push(payload);
    else { this._fragOp = opcode; this._fragParts = [payload]; }
    if (!fin) return;
    const full = this._fragParts.length === 1 ? this._fragParts[0] : Buffer.concat(this._fragParts);
    const isBinary = this._fragOp === OP.BIN;
    this._fragOp = 0; this._fragParts = [];
    this.emit('message', full, isBinary);
  }

  _write(opcode, payload) {
    if (this._closed || this.socket.destroyed) return false;
    if (this.socket.writableLength > MAX_SEND_BACKLOG) return false; // stalled peer — skip
    try { return this.socket.write(encode(opcode, payload)); } catch { this._onClose(); return false; }
  }

  sendText(str) { return this._write(OP.TEXT, Buffer.from(String(str), 'utf8')); }
  sendBinary(buf) { return this._write(OP.BIN, buf); }

  close(code = 1000) {
    if (this._closed) { try { this.socket.end(); } catch { /* gone */ } return; }
    this._closed = true;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    try { this.socket.write(encode(OP.CLOSE, p)); this.socket.end(); } catch { /* gone */ }
    this.emit('close');
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }
}

/**
 * Finish the WebSocket handshake on an http `upgrade` socket. Returns a WSConnection, or null and
 * destroys the socket if the request isn't a valid upgrade. Auth/routing are the caller's job.
 */
export function wsHandshake(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
    try { socket.destroy(); } catch { /* gone */ }
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  const conn = new WSConnection(socket);
  conn._feed(head);
  return conn;
}
