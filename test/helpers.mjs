import { crc32, deflateRawSync } from 'node:zlib';

/** Builds a deflated zip in memory so tests need no zip tooling. */
export const makeZip = (files) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
};

export const sampleConversations = [
  {
    uuid: 'c1',
    name: 'Lease review',
    created_at: '2026-01-02T10:00:00Z',
    updated_at: '2026-01-02T11:00:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'Review this lease', content: [{ type: 'text', text: 'Review this lease' }], created_at: '2026-01-02T10:00:00Z' },
      {
        uuid: 'm2',
        sender: 'assistant',
        text: '',
        created_at: '2026-01-02T10:01:00Z',
        content: [
          { type: 'thinking', thinking: 'Considering clauses' },
          { type: 'text', text: 'Here is a summary.' },
          { type: 'tool_use', name: 'artifacts', input: { id: 'summary', command: 'create', type: 'text/markdown', title: 'Lease summary', content: 'Rent: $1000' } },
        ],
      },
      { uuid: 'm3', sender: 'human', text: '', content: [], created_at: '2026-01-02T10:02:00Z' },
      {
        uuid: 'm4',
        sender: 'assistant',
        text: 'Updated.',
        content: [
          { type: 'text', text: 'Updated.' },
          { type: 'tool_use', name: 'artifacts', input: { id: 'summary', command: 'update', old_str: '$1000', new_str: '$1200' } },
        ],
        created_at: '2026-01-02T10:03:00Z',
      },
    ],
  },
  { uuid: 'c2', name: '', chat_messages: [] },
];
