const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { badRequest } = require('./errors');

/**
 * Local-disk storage for images (logos, favicons). Files are namespaced per owner
 * (`platform/` or `companies/<companyId>/`). Swap for an S3-compatible driver later
 * by keeping the same `saveImage` contract.
 */
const SIGNATURES = [
  { ext: 'png', test: b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', test: b => b.subarray(0, 4).toString('ascii') === 'GIF8' },
  { ext: 'webp', test: b => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'ico', test: b => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 }
];

const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

function createStorage(uploadsDir) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  return {
    dir: uploadsDir,
    /** Validates content by magic bytes and writes it; returns the public URL. */
    saveImage(file, scope, { allowIco = false } = {}) {
      const sig = file && SIGNATURES.find(s => s.test(file.buffer));
      if (!sig || (sig.ext === 'ico' && !allowIco)) throw badRequest('upload.invalid_image', 'Upload a PNG, JPG, WEBP or GIF image');
      if (!/^(platform|companies\/[0-9a-f-]{36})$/.test(scope)) throw new Error('invalid storage scope');
      const dir = path.join(uploadsDir, scope);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${sig.ext}`;
      fs.writeFileSync(path.join(dir, name), file.buffer);
      return `/uploads/${scope}/${name}`;
    }
  };
}

module.exports = { createStorage, imageUpload };
