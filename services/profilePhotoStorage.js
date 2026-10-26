const cloudinary = require('cloudinary').v2;

function isConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim()
    && process.env.CLOUDINARY_API_KEY?.trim()
    && process.env.CLOUDINARY_API_SECRET?.trim(),
  );
}

function getCloudinary() {
  if (!isConfigured()) {
    const error = new Error('Profile photo uploads are not configured.');
    error.status = 503;
    throw error;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    api_key: process.env.CLOUDINARY_API_KEY.trim(),
    api_secret: process.env.CLOUDINARY_API_SECRET.trim(),
    secure: true,
  });
  return cloudinary;
}

function getProfilePhotoUrl(publicId, version) {
  if (!publicId || !isConfigured()) return null;
  return getCloudinary().url(publicId, {
    resource_type: 'image',
    type: 'authenticated',
    sign_url: true,
    secure: true,
    version,
    transformation: [{ width: 512, height: 512, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
  });
}

function uploadProfilePhoto(buffer, publicId) {
  const client = getCloudinary();
  return new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream({
      folder: 'gwic/profile-photos',
      public_id: publicId,
      overwrite: false,
      resource_type: 'image',
      type: 'authenticated',
      transformation: [{ width: 512, height: 512, crop: 'limit', quality: 'auto' }],
    }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
    stream.end(buffer);
  });
}

async function deleteProfilePhoto(publicId) {
  if (!publicId) return;
  const client = getCloudinary();
  const result = await client.uploader.destroy(publicId, {
    resource_type: 'image',
    type: 'authenticated',
    invalidate: true,
  });
  if (result.result !== 'ok' && result.result !== 'not_found') {
    throw new Error('Cloudinary did not confirm profile photo deletion.');
  }
}

module.exports = {
  deleteProfilePhoto,
  getCloudinary,
  getProfilePhotoUrl,
  isConfigured,
  uploadProfilePhoto,
};
