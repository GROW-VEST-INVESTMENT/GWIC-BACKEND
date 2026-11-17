const crypto = require('node:crypto');
const multer = require('multer');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { getCloudinary } = require('./profilePhotoStorage');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': {
    format: 'jpg',
    matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  'image/png': {
    format: 'png',
    matches: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    format: 'webp',
    matches: (buffer) => buffer.length >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP',
  },
};

function privateImageUpload(fieldName, { maxFiles = 1, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: maxFiles, fields: 8, parts: maxFiles + 8 },
    fileFilter(req, file, callback) {
      if (!IMAGE_TYPES[file.mimetype]) {
        const error = new Error('Choose a PNG, JPEG, or WebP image.');
        error.status = 415;
        callback(error);
        return;
      }
      callback(null, true);
    },
  }).array(fieldName, maxFiles);

  return (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      const tooLarge = new Error(`Choose an image no larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
      tooLarge.status = 413;
      return next(tooLarge);
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      const tooMany = new Error(`Attach no more than ${maxFiles} image${maxFiles === 1 ? '' : 's'}.`);
      tooMany.status = 400;
      return next(tooMany);
    }
    return next(error);
  });
}

function validatePrivateImage(file, maxBytes = MAX_IMAGE_BYTES) {
  const image = IMAGE_TYPES[file?.mimetype];
  if (!image || !Buffer.isBuffer(file.buffer) || !image.matches(file.buffer)) {
    const error = new Error('Choose a valid PNG, JPEG, or WebP image.');
    error.status = 415;
    throw error;
  }
  if (file.size > maxBytes || file.buffer.length > maxBytes) {
    const error = new Error(`Choose an image no larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    error.status = 413;
    throw error;
  }
  return image;
}

function safeImageName(fileName) {
  return path.basename((fileName || 'image').replace(/[\\/]/g, '_'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 120) || 'image';
}

function uploadPrivateImage(file, ownerId, purpose) {
  const image = validatePrivateImage(file);
  const cloudinary = getCloudinary();
  const publicId = `gwic/${purpose}/${ownerId}/${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      resource_type: 'image',
      type: 'authenticated',
      public_id: publicId,
      overwrite: false,
      use_filename: false,
      transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
    }, (error, result) => {
      if (error) return reject(error);
      if (!result?.public_id) return reject(new Error('Cloudinary did not confirm the image upload.'));
      return resolve({
        publicId: result.public_id,
        format: image.format,
        mimeType: file.mimetype,
        bytes: file.size,
        name: safeImageName(file.originalname),
        version: result.version,
      });
    });
    stream.end(file.buffer);
  });
}

function privateImageUrl(publicId, format) {
  return getCloudinary().utils.private_download_url(publicId, format, {
    resource_type: 'image',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    attachment: false,
  });
}

async function streamPrivateImage(res, publicId, format) {
  const response = await fetch(privateImageUrl(publicId, format));
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    const error = new Error('The stored private image could not be retrieved.');
    error.status = 502;
    throw error;
  }
  const mimeType = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format];
  if (!mimeType) {
    await response.body.cancel();
    const error = new Error('The stored private image has an unsupported format.');
    error.status = 415;
    throw error;
  }
  res.status(200).set({
    'Cache-Control': 'private, max-age=60',
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
  });
  await pipeline(Readable.fromWeb(response.body), res);
}

async function deletePrivateImage(publicId) {
  if (!publicId) return;
  const result = await getCloudinary().uploader.destroy(publicId, {
    resource_type: 'image',
    type: 'authenticated',
    invalidate: true,
  });
  if (result.result !== 'ok' && result.result !== 'not_found') {
    throw new Error('Cloudinary did not confirm private image deletion.');
  }
}

module.exports = {
  deletePrivateImage,
  privateImageUpload,
  privateImageUrl,
  safeImageName,
  streamPrivateImage,
  uploadPrivateImage,
  validatePrivateImage,
};
