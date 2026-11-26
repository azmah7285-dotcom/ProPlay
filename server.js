import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import 'dotenv/config';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'showcase.json');
const VERCEL_DEPLOY_DIR = path.resolve(__dirname, 'vercel-deploy');
const VERCEL_CONFIG_JSON = JSON.stringify({ cleanUrls: true, trailingSlash: false }, null, 2);
const TOKEN_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_COVER_DATA_URL_BYTES = 2_500_000;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressed = entry.content;
    const compressed = zlib.deflateRawSync(uncompressed);
    const checksum = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const DEFAULT_DATA = {
  profile: {
    studioName: 'ProPlay',
    headline: 'Instant-launch arcade & web builds.',
    subheadline:
      'Every game and website in one sleek darkroom hub. Click any tile to launch directly.',
  },
  passcodeHash: null,
  passcodeSalt: null,
  items: [
    {
      id: 'item-galaga',
      title: 'Galaga',
      url: 'https://gamaga.vercel.app/',
      category: 'game',
      description:
        'Arcade space shooter where you pilot a starfighter against waves of descending alien squadrons.',
      coverImage: '/src/assets/images/game_galaga_arcade_1795684657356.jpg',
      featured: true,
      visits: 0,
      createdAt: '2026-11-26T01:17:00.000Z',
      updatedAt: '2026-11-26T01:17:00.000Z',
    },
    {
      id: 'item-centipede',
      title: 'Centipede',
      url: 'https://centigame.vercel.app/',
      category: 'game',
      description:
        'Fast-paced arcade shooter where you blast winding segmented centipedes across a mushroom field.',
      coverImage: '/src/assets/images/game_centipede_arcade_1795684657858.jpg',
      featured: false,
      visits: 0,
      createdAt: '2026-11-26T01:17:00.000Z',
      updatedAt: '2026-11-26T01:17:00.000Z',
    },
  ],
};

let writeQueue = Promise.resolve();
let syncVercelDeployFolder = async () => {};

async function ensureDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      profile: {
        studioName: parsed.profile?.studioName || DEFAULT_DATA.profile.studioName,
        headline: parsed.profile?.headline || DEFAULT_DATA.profile.headline,
        subheadline: parsed.profile?.subheadline || DEFAULT_DATA.profile.subheadline,
      },
      passcodeHash: typeof parsed.passcodeHash === 'string' ? parsed.passcodeHash : null,
      passcodeSalt: typeof parsed.passcodeSalt === 'string' ? parsed.passcodeSalt : null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
    return structuredClone(DEFAULT_DATA);
  }
}

async function saveDatabase(db) {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${DATA_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tempFile, DATA_FILE);
    await syncVercelDeployFolder(db);
  });
  return writeQueue;
}

function normalizeExternalUrl(rawInput) {
  if (typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : trimmed.includes('://')
      ? trimmed
      : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function validateCoverImage(rawInput) {
  if (typeof rawInput !== 'string') return '';
  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('/src/assets/images/') && !trimmed.includes('..')) {
    return trimmed;
  }

  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
    if (trimmed.length > MAX_COVER_DATA_URL_BYTES) {
      return null;
    }
    return trimmed;
  }

  return normalizeExternalUrl(trimmed);
}

function hashPasscode(passcode, salt) {
  return crypto.scryptSync(passcode, salt, 64).toString('hex');
}

function createCreatorToken(salt) {
  const issuedAt = Date.now().toString();
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${salt}:${issuedAt}`)
    .digest('hex');
  return `${issuedAt}.${sig}`;
}

function verifyCreatorToken(token, salt) {
  if (!token || !salt) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [issuedAt, providedSig] = parts;
  if (!issuedAt || !providedSig) return false;
  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${salt}:${issuedAt}`)
    .digest('hex');

  const bufA = Buffer.from(providedSig, 'hex');
  const bufB = Buffer.from(expectedSig, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function requireCreatorAuth(req, res, next) {
  const db = await ensureDatabase();
  if (!db.passcodeHash || !db.passcodeSalt) {
    next();
    return;
  }
  const token = req.header('x-creator-token');
  if (!verifyCreatorToken(token, db.passcodeSalt)) {
    res.status(401).json({ error: 'Creator passcode required to edit this showcase.' });
    return;
  }
  next();
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.')
    );
  }
  return true;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function extractMetaTag(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patternA = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  const patternB = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const match = html.match(patternA) || html.match(patternB);
  return match?.[1] ? decodeHtmlEntities(match[1]) : '';
}

async function inlineCoverAsset(coverImage) {
  if (!coverImage || !coverImage.startsWith('/src/assets/images/')) {
    return coverImage;
  }
  const safeRelative = coverImage.replace(/^\/+/, '');
  if (safeRelative.includes('..')) return '';
  const fullPath = path.resolve(__dirname, safeRelative);
  const allowedRoot = path.resolve(__dirname, 'src/assets/images');
  if (!fullPath.startsWith(allowedRoot)) return '';
  try {
    const buffer = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function escapeHtmlText(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

async function buildStandaloneHtml(db) {
  const inlinedItems = await Promise.all(
    db.items.map(async (item) => ({
      ...item,
      coverImage: await inlineCoverAsset(item.coverImage),
    }))
  );

  const safeTitle = escapeHtmlText(db.profile.studioName || 'ProPlay');
  const initialPayload = safeJsonForScript({
    profile: db.profile,
    items: inlinedItems,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — Games &amp; Websites Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Outfit:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0A0A0D;
      --surface: #141418;
      --surface-hover: #1B1B21;
      --border: #27272A;
      --text: #F4F4F5;
      --muted: #A1A1AA;
      --accent: #F2B705;
      --accent-hover: #FACC15;
      --ink: #09090B;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-family: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif; color-scheme: dark; scroll-behavior: smooth; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    h1, h2, h3, .font-display { font-family: "Outfit", system-ui, -apple-system, sans-serif; }
    .font-mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
    .tabular-nums { font-variant-numeric: tabular-nums; }
    a { color: inherit; text-decoration: none; }
    button, input, textarea, select { font: inherit; color: inherit; }
    .container { max-width: 1152px; margin: 0 auto; padding: 0 24px; }

    header { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid rgba(39,39,42,0.9); background: rgba(10,10,13,0.92); backdrop-filter: blur(12px); }
    .header-inner { display: flex; align-items: center; justify-content: space-between; gap: 32px; padding: 16px 0; }
    .brand { font-family: "Outfit", sans-serif; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: #fff; white-space: nowrap; }
    .nav { display: none; align-items: center; gap: 28px; }
    @media (min-width: 768px) { .nav { display: flex; } }
    .nav-btn { background: none; border: none; border-bottom: 2px solid transparent; padding: 4px 0; font-size: 14px; font-weight: 500; color: var(--muted); cursor: pointer; white-space: nowrap; transition: color .15s, border-color .15s; }
    .nav-btn:hover { color: #fff; }
    .nav-btn.active { color: #fff; border-bottom-color: var(--accent); }
    .btn-primary { display: inline-flex; align-items: center; gap: 6px; background: var(--accent); color: var(--ink); border: none; border-radius: 8px; padding: 9px 16px; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { display: inline-flex; align-items: center; gap: 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: border-color .15s, background .15s; }
    .btn-secondary:hover { border-color: #52525B; background: var(--surface-hover); }

    .hero { padding: 48px 0 36px; }
    .hero-grid { display: grid; grid-template-columns: 1fr; gap: 32px; align-items: stretch; }
    @media (min-width: 1024px) { .hero-grid { grid-template-columns: 5fr 7fr; } }
    .hero-copy { display: flex; flex-direction: column; justify-content: space-between; }
    .kicker { font-size: 14px; font-weight: 500; color: var(--accent); letter-spacing: 0.01em; }
    .hero-title { margin-top: 14px; font-size: clamp(2.15rem, 3.8vw, 3.15rem); line-height: 1.06; font-weight: 700; letter-spacing: -0.025em; color: #fff; text-wrap: balance; }
    .hero-sub { margin-top: 18px; font-size: 16px; line-height: 1.6; color: var(--muted); max-width: 440px; }
    .hero-actions { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 12px; }
    .btn-light { display: inline-flex; align-items: center; gap: 8px; background: #fff; color: var(--ink); border-radius: 8px; padding: 12px 20px; font-size: 14px; font-weight: 600; transition: background .15s; }
    .btn-light:hover { background: #E4E4E7; }

    .spotlight-card { position: relative; display: block; min-height: 320px; height: 100%; border-radius: 16px; border: 1px solid var(--border); background: var(--surface); overflow: hidden; }
    .spotlight-card img { width: 100%; height: 100%; min-height: 320px; object-fit: cover; display: block; transition: transform .2s ease-out; }
    .spotlight-card:hover img { transform: scale(1.02); }
    .spotlight-scrim { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0.35) 55%, transparent); }
    .spotlight-body { position: absolute; inset: auto 0 0 0; padding: 24px 28px; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
    .spotlight-meta { font-size: 12px; color: #D4D4D8; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .spotlight-meta .feat { color: var(--accent); font-weight: 600; }
    .spotlight-title { margin-top: 6px; font-size: 28px; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
    .spotlight-desc { margin-top: 6px; font-size: 14px; color: #D4D4D8; max-width: 480px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

    .stats { margin-top: 44px; display: grid; grid-template-columns: repeat(2, 1fr); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    @media (min-width: 640px) { .stats { grid-template-columns: repeat(4, 1fr); } }
    .stat { padding: 20px 16px; border-bottom: 1px solid var(--border); }
    @media (min-width: 640px) { .stat { border-bottom: none; border-right: 1px solid var(--border); } .stat:last-child { border-right: none; } .stat:first-child { padding-left: 0; } }
    .stat-val { font-family: "Outfit", sans-serif; font-size: 26px; font-weight: 700; color: #fff; }
    .stat-val.accent { color: var(--accent); }
    .stat-lbl { margin-top: 4px; font-size: 12px; font-weight: 500; color: var(--muted); }

    .catalog { padding: 28px 0 72px; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--border); padding-bottom: 20px; }
    .toolbar-left, .toolbar-right { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .seg { display: inline-flex; gap: 4px; padding: 4px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); }
    .seg-btn { border: none; background: transparent; color: var(--muted); padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .seg-btn.active { background: var(--accent); color: var(--ink); }
    .search-input, .select-input { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 13px; color: var(--text); outline: none; }
    .search-input:focus, .select-input:focus { border-color: var(--accent); }

    .grid { margin-top: 28px; display: grid; grid-template-columns: 1fr; gap: 28px; }
    @media (min-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, 1fr); } }
    .card { position: relative; border: 1px solid var(--border); background: var(--surface); border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; transition: border-color .15s; }
    .card:hover { border-color: #3F3F46; }
    .card-link { display: flex; flex-direction: column; height: 100%; }
    .card-thumb { aspect-ratio: 4/3; width: 100%; overflow: hidden; border-bottom: 1px solid var(--border); background: var(--bg); }
    .card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s ease-out; }
    .card:hover .card-thumb img { transform: scale(1.03); }
    .card-fallback { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: linear-gradient(135deg, #18181D, #101014 60%, #1F1A0D); padding: 16px; text-align: center; }
    .card-body { padding: 20px; display: flex; flex-direction: column; justify-content: space-between; flex: 1; }
    .card-meta { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; overflow: hidden; }
    .card-meta strong { color: #E4E4E7; font-weight: 500; }
    .card-meta .host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-title { margin-top: 8px; font-size: 20px; font-weight: 700; color: #fff; letter-spacing: -0.015em; transition: color .15s; }
    .card:hover .card-title { color: var(--accent); }
    .card-desc { margin-top: 8px; font-size: 14px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card-foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(39,39,42,0.8); display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; color: #D4D4D8; }
    .card:hover .card-foot { color: var(--accent); }
    .card-actions { position: absolute; top: 12px; right: 12px; z-index: 10; display: flex; gap: 6px; background: rgba(10,10,13,0.92); border: 1px solid #3F3F46; border-radius: 8px; padding: 4px; }
    .icon-btn { border: none; background: transparent; color: var(--muted); padding: 5px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; }
    .icon-btn:hover { background: #27272A; color: #fff; }
    .icon-btn.danger:hover { background: #7F1D1D; color: #FECACA; }

    .modal-backdrop { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.75); padding: 16px; }
    .modal-backdrop.open { display: flex; }
    .modal { width: 100%; max-width: 520px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; }
    .modal h2 { font-size: 22px; color: #fff; }
    .field { margin-top: 14px; }
    .field label { display: block; font-size: 13px; font-weight: 500; color: #E4E4E7; margin-bottom: 6px; }
    .field input, .field textarea, .field select { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; font-size: 14px; color: var(--text); }
    .modal-actions { margin-top: 20px; display: flex; justify-content: flex-end; gap: 10px; }
    .err-box { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: rgba(127,29,29,0.45); border: 1px solid #991B1B; color: #FECACA; font-size: 13px; display: none; }
    footer { border-top: 1px solid var(--border); padding: 28px 0; font-size: 12px; color: var(--muted); }
    .footer-inner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    .empty { margin-top: 32px; border: 1px dashed var(--border); border-radius: 16px; padding: 48px 24px; text-align: center; background: var(--surface); }
  </style>
</head>
<body>
  <header>
    <div class="container header-inner">
      <a href="#top" class="brand" id="brandName">${safeTitle}</a>
      <nav class="nav" aria-label="Categories">
        <button type="button" class="nav-btn active" data-nav="all">All Works</button>
        <button type="button" class="nav-btn" data-nav="game">Games</button>
        <button type="button" class="nav-btn" data-nav="website">Websites</button>
        <a href="#spotlight" class="nav-btn">Spotlight</a>
      </nav>
      <button type="button" class="btn-primary" id="openAddBtn">+ Add Work</button>
    </div>
  </header>

  <main id="top" class="container">
    <section id="spotlight" class="hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <div>
            <p class="kicker">Direct-Launch Arcade &amp; Web Deck</p>
            <h1 class="hero-title" id="heroHeadline"></h1>
            <p class="hero-sub" id="heroSub"></p>
          </div>
          <div class="hero-actions">
            <a href="#catalog" class="btn-light">Browse library &#8599;</a>
            <button type="button" class="btn-secondary" id="heroAddBtn">+ Add game or site</button>
          </div>
        </div>
        <div id="spotlightSlot"></div>
      </div>

      <div class="stats">
        <div class="stat"><div class="stat-val tabular-nums" id="statTotal">0</div><div class="stat-lbl">Published works</div></div>
        <div class="stat"><div class="stat-val tabular-nums" id="statGames">0</div><div class="stat-lbl">Playable games</div></div>
        <div class="stat"><div class="stat-val tabular-nums" id="statSites">0</div><div class="stat-lbl">Live websites</div></div>
        <div class="stat"><div class="stat-val accent tabular-nums" id="statVisits">0</div><div class="stat-lbl">Direct launches</div></div>
      </div>
    </section>

    <section id="catalog" class="catalog">
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="seg" role="tablist">
            <button type="button" class="seg-btn active" data-filter="all">All</button>
            <button type="button" class="seg-btn" data-filter="game">Games</button>
            <button type="button" class="seg-btn" data-filter="website">Websites</button>
          </div>
          <input type="search" id="searchInput" class="search-input" placeholder="Search games or URLs..." />
        </div>
        <div class="toolbar-right">
          <select id="sortSelect" class="select-input" aria-label="Sort works">
            <option value="featured">Featured First</option>
            <option value="newest">Newest Added</option>
            <option value="visits">Most Launched</option>
            <option value="alpha">Alphabetical</option>
          </select>
          <button type="button" class="btn-secondary" id="manageBtn">Manage</button>
          <button type="button" class="btn-secondary" id="downloadSelfBtn">Save Updated HTML</button>
        </div>
      </div>
      <div id="gridMount"></div>
    </section>
  </main>

  <footer>
    <div class="container footer-inner">
      <div><strong id="footerBrand" style="color:#fff"></strong> &middot; <span id="footerCount"></span></div>
      <div>Self-contained ProPlay HTML file</div>
    </div>
  </footer>

  <div class="modal-backdrop" id="itemModal" role="dialog" aria-modal="true">
    <div class="modal">
      <h2 id="modalHeading">Add a game or website</h2>
      <div class="err-box" id="modalErr"></div>
      <form id="itemForm">
        <div class="field">
          <label for="fType">Type</label>
          <select id="fType">
            <option value="game">Game</option>
            <option value="website">Website</option>
          </select>
        </div>
        <div class="field">
          <label for="fUrl">Destination URL</label>
          <input id="fUrl" type="text" placeholder="https://example.com" />
        </div>
        <div class="field">
          <label for="fTitle">Title</label>
          <input id="fTitle" type="text" maxlength="80" placeholder="Game or website title" />
        </div>
        <div class="field">
          <label for="fDesc">Short description (optional)</label>
          <textarea id="fDesc" rows="2" maxlength="240"></textarea>
        </div>
        <div class="field">
          <label for="fCover">Cover image URL (optional)</label>
          <input id="fCover" type="text" placeholder="https://..." />
        </div>
        <div class="field" style="display:flex;align-items:center;gap:8px;">
          <input id="fFeatured" type="checkbox" style="width:auto;" />
          <label for="fFeatured" style="margin:0;">Feature in top spotlight</label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancelModalBtn">Cancel</button>
          <button type="submit" class="btn-primary">Save</button>
        </div>
      </form>
    </div>
  </div>

  <script id="proplay-seed" type="application/json">${initialPayload}</script>
  <script>
    (function () {
      var STORAGE_KEY = 'proplay_standalone_v1';
      var seed = JSON.parse(document.getElementById('proplay-seed').textContent);
      var state = { profile: seed.profile, items: seed.items };
      try {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          var parsed = JSON.parse(saved);
          if (parsed && Array.isArray(parsed.items)) state = parsed;
        }
      } catch (e) {}

      var filter = 'all';
      var query = '';
      var sortBy = 'featured';
      var manage = false;
      var editingId = null;

      function persist() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
      }

      function normalizeUrl(raw) {
        var s = (raw || '').trim();
        if (!s) return null;
        if (!/^https?:\\/\\//i.test(s)) s = 'https://' + s;
        try {
          var u = new URL(s);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
          return u.toString();
        } catch (e) { return null; }
      }

      function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\\./, ''); } catch (e) { return url; }
      }

      function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
      }

      function recordVisit(id) {
        state.items = state.items.map(function (it) {
          return it.id === id ? Object.assign({}, it, { visits: (it.visits || 0) + 1 }) : it;
        });
        persist();
        render();
      }

      function render() {
        document.getElementById('brandName').textContent = state.profile.studioName;
        document.getElementById('footerBrand').textContent = state.profile.studioName;
        document.getElementById('heroHeadline').textContent = state.profile.headline;
        document.getElementById('heroSub').textContent = state.profile.subheadline;

        var games = state.items.filter(function (i) { return i.category === 'game'; }).length;
        var sites = state.items.filter(function (i) { return i.category === 'website'; }).length;
        var visits = state.items.reduce(function (a, i) { return a + (i.visits || 0); }, 0);
        document.getElementById('statTotal').textContent = String(state.items.length);
        document.getElementById('statGames').textContent = String(games);
        document.getElementById('statSites').textContent = String(sites);
        document.getElementById('statVisits').textContent = String(visits);
        document.getElementById('footerCount').textContent = state.items.length + ' curated links';

        var spotlight = state.items.find(function (i) { return i.featured; }) || state.items[0] || null;
        var slot = document.getElementById('spotlightSlot');
        slot.innerHTML = '';
        if (spotlight) {
          var a = el('a', 'spotlight-card');
          a.href = spotlight.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.addEventListener('click', function () { recordVisit(spotlight.id); });
          if (spotlight.coverImage) {
            var img = el('img');
            img.src = spotlight.coverImage;
            img.alt = spotlight.title;
            a.appendChild(img);
          } else {
            var fb = el('div', 'card-fallback');
            fb.appendChild(el('strong', 'font-display', spotlight.title));
            a.appendChild(fb);
          }
          a.appendChild(el('div', 'spotlight-scrim'));
          var body = el('div', 'spotlight-body');
          var left = el('div');
          var meta = el('div', 'spotlight-meta');
          meta.appendChild(el('span', 'feat', 'Featured'));
          meta.appendChild(el('span', '', '·'));
          meta.appendChild(el('span', '', spotlight.category === 'game' ? 'Game' : 'Website'));
          meta.appendChild(el('span', '', '·'));
          meta.appendChild(el('span', 'font-mono', hostOf(spotlight.url)));
          left.appendChild(meta);
          left.appendChild(el('h2', 'spotlight-title', spotlight.title));
          if (spotlight.description) left.appendChild(el('p', 'spotlight-desc', spotlight.description));
          body.appendChild(left);
          body.appendChild(el('span', 'btn-primary', 'Play now \\u2197'));
          a.appendChild(body);
          slot.appendChild(a);
        } else {
          var emptySpot = el('div', 'empty');
          emptySpot.appendChild(el('p', 'font-display', 'No spotlight item yet'));
          slot.appendChild(emptySpot);
        }

        var filtered = state.items.filter(function (item) {
          if (filter !== 'all' && item.category !== filter) return false;
          if (!query) return true;
          var q = query.toLowerCase();
          return item.title.toLowerCase().indexOf(q) !== -1 ||
            (item.description || '').toLowerCase().indexOf(q) !== -1 ||
            item.url.toLowerCase().indexOf(q) !== -1;
        }).slice().sort(function (a, b) {
          if (sortBy === 'featured') {
            if (a.featured !== b.featured) return a.featured ? -1 : 1;
            return (b.createdAt || '').localeCompare(a.createdAt || '');
          }
          if (sortBy === 'newest') return (b.createdAt || '').localeCompare(a.createdAt || '');
          if (sortBy === 'visits') return (b.visits || 0) - (a.visits || 0);
          return a.title.localeCompare(b.title);
        });

        var mount = document.getElementById('gridMount');
        mount.innerHTML = '';
        if (filtered.length === 0) {
          var emp = el('div', 'empty');
          emp.appendChild(el('h3', 'font-display', 'No matching works found'));
          mount.appendChild(emp);
          return;
        }

        var grid = el('div', 'grid');
        filtered.forEach(function (item) {
          var card = el('article', 'card');
          if (manage) {
            var actions = el('div', 'card-actions');
            var editBtn = el('button', 'icon-btn', 'Edit');
            editBtn.type = 'button';
            editBtn.addEventListener('click', function () { openModal(item); });
            var delBtn = el('button', 'icon-btn danger', 'Delete');
            delBtn.type = 'button';
            delBtn.addEventListener('click', function () {
              state.items = state.items.filter(function (x) { return x.id !== item.id; });
              persist();
              render();
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            card.appendChild(actions);
          }

          var link = el('a', 'card-link');
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.addEventListener('click', function () { recordVisit(item.id); });

          var thumb = el('div', 'card-thumb');
          if (item.coverImage) {
            var im = el('img');
            im.src = item.coverImage;
            im.alt = item.title;
            thumb.appendChild(im);
          } else {
            var cfb = el('div', 'card-fallback');
            cfb.appendChild(el('strong', 'font-display', item.title));
            cfb.appendChild(el('span', 'font-mono', hostOf(item.url)));
            thumb.appendChild(cfb);
          }
          link.appendChild(thumb);

          var cbody = el('div', 'card-body');
          var top = el('div');
          var cmeta = el('div', 'card-meta');
          cmeta.appendChild(el('strong', '', item.category === 'game' ? 'Game' : 'Website'));
          cmeta.appendChild(el('span', '', '·'));
          cmeta.appendChild(el('span', 'font-mono host', hostOf(item.url)));
          cmeta.appendChild(el('span', '', '·'));
          cmeta.appendChild(el('span', 'tabular-nums', (item.visits || 0) + ' launches'));
          top.appendChild(cmeta);
          top.appendChild(el('h3', 'card-title', item.title));
          if (item.description) top.appendChild(el('p', 'card-desc', item.description));
          cbody.appendChild(top);

          var foot = el('div', 'card-foot');
          foot.appendChild(el('span', '', item.category === 'game' ? 'Play game' : 'Visit website'));
          foot.appendChild(el('span', '', '\\u2197'));
          cbody.appendChild(foot);
          link.appendChild(cbody);
          card.appendChild(link);
          grid.appendChild(card);
        });
        mount.appendChild(grid);
      }

      function openModal(item) {
        editingId = item ? item.id : null;
        document.getElementById('modalHeading').textContent = item ? 'Edit game or website' : 'Add a game or website';
        document.getElementById('fType').value = item ? item.category : 'game';
        document.getElementById('fUrl').value = item ? item.url : '';
        document.getElementById('fTitle').value = item ? item.title : '';
        document.getElementById('fDesc').value = item ? (item.description || '') : '';
        document.getElementById('fCover').value = item ? (item.coverImage || '') : '';
        document.getElementById('fFeatured').checked = Boolean(item && item.featured);
        document.getElementById('modalErr').style.display = 'none';
        document.getElementById('itemModal').classList.add('open');
      }

      function closeModal() {
        document.getElementById('itemModal').classList.remove('open');
      }

      document.getElementById('openAddBtn').addEventListener('click', function () { openModal(null); });
      document.getElementById('heroAddBtn').addEventListener('click', function () { openModal(null); });
      document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
      document.getElementById('itemModal').addEventListener('click', function (e) {
        if (e.target === this) closeModal();
      });

      document.getElementById('itemForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var errBox = document.getElementById('modalErr');
        var url = normalizeUrl(document.getElementById('fUrl').value);
        var title = document.getElementById('fTitle').value.trim();
        var category = document.getElementById('fType').value === 'website' ? 'website' : 'game';
        var desc = document.getElementById('fDesc').value.trim();
        var cover = document.getElementById('fCover').value.trim();
        var featured = document.getElementById('fFeatured').checked;
        if (!url || !title) {
          errBox.textContent = 'Please provide both a valid URL and title.';
          errBox.style.display = 'block';
          return;
        }
        if (featured) {
          state.items = state.items.map(function (i) { return Object.assign({}, i, { featured: false }); });
        }
        var now = new Date().toISOString();
        if (editingId) {
          state.items = state.items.map(function (i) {
            return i.id === editingId
              ? Object.assign({}, i, { title: title, url: url, category: category, description: desc, coverImage: cover, featured: featured, updatedAt: now })
              : i;
          });
        } else {
          state.items.unshift({
            id: 'item-' + Math.random().toString(36).slice(2, 10),
            title: title,
            url: url,
            category: category,
            description: desc,
            coverImage: cover,
            featured: featured,
            visits: 0,
            createdAt: now,
            updatedAt: now
          });
        }
        persist();
        closeModal();
        render();
      });

      document.querySelectorAll('[data-filter]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          filter = btn.getAttribute('data-filter');
          document.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('active', b === btn); });
          document.querySelectorAll('[data-nav]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-nav') === filter); });
          render();
        });
      });

      document.querySelectorAll('[data-nav]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          filter = btn.getAttribute('data-nav');
          document.querySelectorAll('[data-nav]').forEach(function (b) { b.classList.toggle('active', b === btn); });
          document.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-filter') === filter); });
          document.getElementById('catalog').scrollIntoView({ behavior: 'smooth' });
          render();
        });
      });

      document.getElementById('searchInput').addEventListener('input', function (e) {
        query = e.target.value;
        render();
      });
      document.getElementById('sortSelect').addEventListener('change', function (e) {
        sortBy = e.target.value;
        render();
      });
      document.getElementById('manageBtn').addEventListener('click', function () {
        manage = !manage;
        this.textContent = manage ? 'Done' : 'Manage';
        render();
      });
      document.getElementById('downloadSelfBtn').addEventListener('click', function () {
        var clone = document.documentElement.cloneNode(true);
        var seedNode = clone.querySelector('#proplay-seed');
        if (seedNode) {
          seedNode.textContent = JSON.stringify(state).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
        }
        var blob = new Blob(['<!doctype html>\\n' + clone.outerHTML], { type: 'text/html;charset=utf-8' });
        var href = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = href;
        a.download = 'proplay.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      });

      render();
    })();
  </script>
</body>
</html>`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));

  app.get('/api/items', async (_req, res) => {
    try {
      const db = await ensureDatabase();
      res.json({
        items: db.items,
        profile: db.profile,
        hasPasscode: Boolean(db.passcodeHash),
      });
    } catch (error) {
      console.error('Failed to read showcase database:', error);
      res.status(500).json({ error: 'Unable to load showcase items.' });
    }
  });

  app.post('/api/auth/verify', async (req, res) => {
    const db = await ensureDatabase();
    if (!db.passcodeHash || !db.passcodeSalt) {
      res.json({ unlocked: true, hasPasscode: false });
      return;
    }
    const token = req.header('x-creator-token');
    const unlocked = verifyCreatorToken(token, db.passcodeSalt);
    res.json({ unlocked, hasPasscode: true });
  });

  app.post('/api/auth/unlock', async (req, res) => {
    const db = await ensureDatabase();
    if (!db.passcodeHash || !db.passcodeSalt) {
      res.json({ unlocked: true, token: '' });
      return;
    }
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    const candidate = hashPasscode(passcode, db.passcodeSalt);
    const bufA = Buffer.from(candidate, 'hex');
    const bufB = Buffer.from(db.passcodeHash, 'hex');
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      res.status(401).json({ error: 'Incorrect passcode.' });
      return;
    }
    const token = createCreatorToken(db.passcodeSalt);
    res.json({ unlocked: true, token });
  });

  app.post('/api/auth/passcode', requireCreatorAuth, async (req, res) => {
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    const db = await ensureDatabase();

    if (!passcode) {
      db.passcodeHash = null;
      db.passcodeSalt = null;
      await saveDatabase(db);
      res.json({ hasPasscode: false, token: '' });
      return;
    }

    if (passcode.length < 4 || passcode.length > 64) {
      res.status(400).json({ error: 'Passcode must be between 4 and 64 characters.' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    db.passcodeSalt = salt;
    db.passcodeHash = hashPasscode(passcode, salt);
    await saveDatabase(db);

    const token = createCreatorToken(salt);
    res.json({ hasPasscode: true, token });
  });

  app.patch('/api/profile', requireCreatorAuth, async (req, res) => {
    const db = await ensureDatabase();
    const studioName =
      typeof req.body?.studioName === 'string' ? req.body.studioName.trim().slice(0, 48) : '';
    const headline =
      typeof req.body?.headline === 'string' ? req.body.headline.trim().slice(0, 120) : '';
    const subheadline =
      typeof req.body?.subheadline === 'string' ? req.body.subheadline.trim().slice(0, 240) : '';

    if (!studioName || !headline) {
      res.status(400).json({ error: 'Showcase name and headline are required.' });
      return;
    }

    db.profile = {
      studioName,
      headline,
      subheadline: subheadline || db.profile.subheadline,
    };
    await saveDatabase(db);
    res.json({ profile: db.profile });
  });

  app.post('/api/items', requireCreatorAuth, async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 80) : '';
    const url = normalizeExternalUrl(req.body?.url);
    const category = req.body?.category === 'website' ? 'website' : 'game';
    const description =
      typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 240) : '';
    const coverImage = validateCoverImage(req.body?.coverImage);
    const featured = Boolean(req.body?.featured);

    if (!title) {
      res.status(400).json({ error: 'Please enter a title for your game or website.' });
      return;
    }
    if (!url) {
      res.status(400).json({ error: 'Please enter a valid website URL (e.g. https://mygame.itch.io).' });
      return;
    }
    if (coverImage === null) {
      res.status(400).json({ error: 'Cover image must be a valid image URL or uploaded image under 2MB.' });
      return;
    }

    const db = await ensureDatabase();
    const now = new Date().toISOString();
    const newItem = {
      id: `item-${crypto.randomUUID().slice(0, 8)}`,
      title,
      url,
      category,
      description,
      coverImage,
      featured,
      visits: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (featured) {
      db.items = db.items.map((item) => ({ ...item, featured: false }));
    }
    db.items.unshift(newItem);
    await saveDatabase(db);
    res.status(201).json({ item: newItem, items: db.items });
  });

  app.post('/api/items/remove-websites', requireCreatorAuth, async (_req, res) => {
    const db = await ensureDatabase();
    db.items = db.items.filter((item) => item.category !== 'website');
    await saveDatabase(db);
    res.json({ items: db.items });
  });

  app.post('/api/items/import', requireCreatorAuth, async (req, res) => {
    const incoming = req.body?.items;
    const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
    if (!Array.isArray(incoming)) {
      res.status(400).json({ error: 'Import file must contain an array of items.' });
      return;
    }

    const sanitized = [];
    const now = new Date().toISOString();
    for (const raw of incoming.slice(0, 100)) {
      const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 80) : '';
      const url = normalizeExternalUrl(raw?.url);
      const coverImage = validateCoverImage(raw?.coverImage);
      if (!title || !url || coverImage === null) continue;
      sanitized.push({
        id: `item-${crypto.randomUUID().slice(0, 8)}`,
        title,
        url,
        category: raw?.category === 'website' ? 'website' : 'game',
        description:
          typeof raw?.description === 'string' ? raw.description.trim().slice(0, 240) : '',
        coverImage,
        featured: Boolean(raw?.featured),
        visits: typeof raw?.visits === 'number' && raw.visits >= 0 ? Math.floor(raw.visits) : 0,
        createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: now,
      });
    }

    if (sanitized.length === 0) {
      res.status(400).json({ error: 'No valid games or websites found in the imported file.' });
      return;
    }

    const db = await ensureDatabase();
    if (mode === 'replace') {
      db.items = sanitized;
    } else {
      const existingUrls = new Set(db.items.map((item) => item.url));
      const uniqueNew = sanitized.filter((item) => !existingUrls.has(item.url));
      db.items = [...uniqueNew, ...db.items];
    }
    await saveDatabase(db);
    res.json({ items: db.items, importedCount: sanitized.length });
  });

  app.patch('/api/items/:id', requireCreatorAuth, async (req, res) => {
    const { id } = req.params;
    const db = await ensureDatabase();
    const index = db.items.findIndex((item) => item.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const existing = db.items[index];
    const nextTitle =
      typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 80) : existing.title;
    const nextUrl =
      req.body?.url !== undefined ? normalizeExternalUrl(req.body.url) : existing.url;
    const nextCategory =
      req.body?.category === 'game' || req.body?.category === 'website'
        ? req.body.category
        : existing.category;
    const nextDescription =
      typeof req.body?.description === 'string'
        ? req.body.description.trim().slice(0, 240)
        : existing.description;
    const nextCoverImage =
      req.body?.coverImage !== undefined
        ? validateCoverImage(req.body.coverImage)
        : existing.coverImage;
    const nextFeatured =
      typeof req.body?.featured === 'boolean' ? req.body.featured : existing.featured;

    if (!nextTitle) {
      res.status(400).json({ error: 'Title cannot be empty.' });
      return;
    }
    if (!nextUrl) {
      res.status(400).json({ error: 'Please enter a valid website URL.' });
      return;
    }
    if (nextCoverImage === null) {
      res.status(400).json({ error: 'Invalid cover image URL or file size exceeded 2MB.' });
      return;
    }

    if (nextFeatured) {
      db.items = db.items.map((item) => ({ ...item, featured: false }));
    }

    const updated = {
      ...existing,
      title: nextTitle,
      url: nextUrl,
      category: nextCategory,
      description: nextDescription,
      coverImage: nextCoverImage,
      featured: nextFeatured,
      updatedAt: new Date().toISOString(),
    };
    db.items[index] = updated;
    await saveDatabase(db);
    res.json({ item: updated, items: db.items });
  });

  app.delete('/api/items/:id', requireCreatorAuth, async (req, res) => {
    const { id } = req.params;
    const db = await ensureDatabase();
    const filtered = db.items.filter((item) => item.id !== id);
    if (filtered.length === db.items.length) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    db.items = filtered;
    await saveDatabase(db);
    res.json({ items: db.items });
  });

  app.post('/api/items/:id/visit', async (req, res) => {
    const { id } = req.params;
    const db = await ensureDatabase();
    const target = db.items.find((item) => item.id === id);
    if (!target) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    target.visits = (target.visits || 0) + 1;
    await saveDatabase(db);
    res.json({ visits: target.visits });
  });

  app.post('/api/metadata', async (req, res) => {
    const normalizedUrl = normalizeExternalUrl(req.body?.url);
    if (!normalizedUrl) {
      res.status(400).json({ error: 'Enter a valid http/https website URL first.' });
      return;
    }

    try {
      const target = new URL(normalizedUrl);
      if (target.hostname === 'localhost' || target.hostname.endsWith('.local')) {
        res.status(400).json({ error: 'Private or local addresses cannot be previewed.' });
        return;
      }

      const addresses = await dns.lookup(target.hostname, { all: true });
      if (addresses.some((addr) => isPrivateIp(addr.address))) {
        res.status(400).json({ error: 'Private IP addresses cannot be previewed.' });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      const response = await fetch(normalizedUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ProPlayMetadataBot/1.0 (+https://proplay.local)',
          Accept: 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        res.json({
          title: target.hostname.replace(/^www\./, ''),
          description: '',
          coverImage: '',
          normalizedUrl,
        });
        return;
      }

      const html = (await response.text()).slice(0, 120_000);
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const ogTitle = extractMetaTag(html, 'og:title');
      const rawTitle = ogTitle || (titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]) : '');
      const description =
        extractMetaTag(html, 'og:description') || extractMetaTag(html, 'description');
      const rawOgImage = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image');

      let coverImage = '';
      if (rawOgImage) {
        try {
          const resolved = new URL(rawOgImage, normalizedUrl);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            coverImage = resolved.toString();
          }
        } catch {
          coverImage = '';
        }
      }

      res.json({
        title: rawTitle.slice(0, 80),
        description: description.slice(0, 240),
        coverImage,
        normalizedUrl,
      });
    } catch {
      const target = new URL(normalizedUrl);
      res.json({
        title: target.hostname.replace(/^www\./, ''),
        description: '',
        coverImage: '',
        normalizedUrl,
      });
    }
  });

  syncVercelDeployFolder = async (db) => {
    const html = await buildStandaloneHtml(db);
    await fs.mkdir(VERCEL_DEPLOY_DIR, { recursive: true });
    await fs.writeFile(path.join(VERCEL_DEPLOY_DIR, 'index.html'), html, 'utf8');
    await fs.writeFile(path.join(VERCEL_DEPLOY_DIR, 'vercel.json'), VERCEL_CONFIG_JSON, 'utf8');
  };

  const initialDb = await ensureDatabase();
  await syncVercelDeployFolder(initialDb);

  app.get('/api/export/html', async (_req, res) => {
    try {
      const db = await ensureDatabase();
      const html = await buildStandaloneHtml(db);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="proplay.html"');
      res.send(html);
    } catch (error) {
      console.error('Failed to export HTML:', error);
      res.status(500).json({ error: 'Unable to export HTML file.' });
    }
  });

  app.get('/api/export/vercel', async (_req, res) => {
    try {
      const db = await ensureDatabase();
      const html = await buildStandaloneHtml(db);
      const zipBuffer = createZipArchive([
        { name: 'proplay/index.html', content: Buffer.from(html, 'utf8') },
        { name: 'proplay/vercel.json', content: Buffer.from(VERCEL_CONFIG_JSON, 'utf8') },
      ]);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="proplay-vercel.zip"');
      res.send(zipBuffer);
    } catch (error) {
      console.error('Failed to export Vercel folder:', error);
      res.status(500).json({ error: 'Unable to export Vercel folder.' });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    app.use('/src/assets', express.static(path.resolve(__dirname, 'src/assets')));
    app.get('/', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'index.html'));
    });
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ProPlay server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
