const express = require('express');
const multer = require('multer');
const requireAuth = require('../middleware/requireAuth');
const requireTransactionAccess = require('../middleware/requireTransactionAccess');
const {
  getProfile,
  updateProfile,
  uploadAccountPhoto,
  removeAccountPhoto,
  getPreferences,
  updatePreferences,
  getNotificationPreferences,
  updateNotificationPreferences,
  changePassword,
  getVerificationStatus,
  createVerificationRequest,
  getLinkedBanks,
  createLinkedBank,
  setDefaultBank,
  deleteLinkedBank,
  listSupportRequests,
  createSupportRequest,
  getAbout,
} = require('../controllers/accountController');

const router = express.Router();
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

function receiveProfilePhoto(req, res, next) {
  photoUpload.single('photo')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Choose a photo smaller than 2 MB.' });
    }
    return res.status(400).json({ message: 'Choose a PNG, JPEG, or WebP photo.' });
  });
}

router.use(requireAuth);
router.get('/about', getAbout);
router.get('/profile', getProfile);
router.patch('/profile', updateProfile);
router.post('/profile/photo', receiveProfilePhoto, uploadAccountPhoto);
router.delete('/profile/photo', removeAccountPhoto);
router.patch('/password', changePassword);
router.get('/preferences', getPreferences);
router.patch('/preferences', updatePreferences);
router.get('/notifications', getNotificationPreferences);
router.patch('/notifications', updateNotificationPreferences);
router.get('/verification', getVerificationStatus);
router.post('/verification', createVerificationRequest);
router.get('/banks', getLinkedBanks);
router.post('/banks', requireTransactionAccess, createLinkedBank);
router.patch('/banks/:bankId/default', requireTransactionAccess, setDefaultBank);
router.delete('/banks/:bankId', requireTransactionAccess, deleteLinkedBank);
router.get('/support', listSupportRequests);
router.post('/support', createSupportRequest);

module.exports = router;
