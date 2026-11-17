const crypto = require('node:crypto');
const path = require('node:path');
const multer = require('multer');
const { getCloudinary } = require('./profilePhotoStorage');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const FILE_TYPES = {
  '.pdf': { format: 'pdf', mimeType: 'application/pdf' },
  '.docx': {
    format: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  '.jpg': { format: 'jpg', mimeType: 'image/jpeg' },
  '.jpeg': { format: 'jpg', mimeType: 'image/jpeg' },
  '.png': { format: 'png', mimeType: 'image/png' },
};

const applicationDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 5, fields: 12, parts: 20 },
});

function documentType(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const type = FILE_TYPES[extension];
  if (!type || file.mimetype !== type.mimeType) return null;

  const bytes = file.buffer;
  const validContent = type.format === 'pdf'
    ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : type.format === 'docx'
      ? bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      : type.format === 'jpg'
        ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return validContent ? type : null;
}

function validateApplicationDocuments(files = []) {
  if (files.length > 5 || files.some((file) => !documentType(file))) {
    const error = new Error('Attach up to five PDF, DOCX, JPG, or PNG files with matching file contents.');
    error.status = 415;
    throw error;
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    const error = new Error('Application documents must total 20 MB or less.');
    error.status = 413;
    throw error;
  }
}

function safeFileName(fileName) {
  return path.basename((fileName || 'application-document').replace(/[\\/]/g, '_'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 180) || 'application-document';
}

function uploadOne(file, userId) {
  const cloudinary = getCloudinary();
  const type = documentType(file);
  const publicId = `gwic/connect-applications/${userId}/${crypto.randomUUID()}.${type.format}`;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      resource_type: 'raw',
      type: 'authenticated',
      public_id: publicId,
      overwrite: false,
      use_filename: false,
    }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      if (!result?.public_id) {
        reject(new Error('Cloudinary did not return an application document ID.'));
        return;
      }
      resolve({
        name: safeFileName(file.originalname),
        publicId: result.public_id,
        format: type.format,
        mimeType: type.mimeType,
        bytes: file.size,
      });
    });
    stream.end(file.buffer);
  });
}

async function uploadApplicationDocuments(files, userId) {
  const uploaded = [];
  try {
    for (const file of files) uploaded.push(await uploadOne(file, userId));
    return uploaded;
  } catch (error) {
    await deleteApplicationDocuments(uploaded);
    throw error;
  }
}

async function deleteApplicationDocuments(documents = []) {
  if (!documents.length) return;
  const cloudinary = getCloudinary();
  await Promise.all(documents.map(async (document) => {
    const result = await cloudinary.uploader.destroy(document.publicId, {
      resource_type: 'raw',
      type: 'authenticated',
      invalidate: true,
    });
    if (result.result !== 'ok' && result.result !== 'not_found') {
      throw new Error('Cloudinary did not confirm application document deletion.');
    }
  }));
}

function applicationDocumentDownloadUrl(document) {
  return getCloudinary().utils.private_download_url(document.publicId, document.format, {
    resource_type: 'raw',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    attachment: true,
  });
}

module.exports = {
  applicationDocumentDownloadUrl,
  applicationDocumentUpload,
  deleteApplicationDocuments,
  documentType,
  validateApplicationDocuments,
};
