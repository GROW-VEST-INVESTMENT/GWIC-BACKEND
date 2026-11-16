const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const notifications = await Notification.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean();

    return res.json({
      notifications: notifications.map((notification) => ({
        id: notification._id.toString(),
        title: notification.title,
        message: notification.message,
        category: notification.category,
        type: notification.type,
        icon: notification.icon,
        color: notification.color,
        amount: notification.amount || '',
        time: new Intl.DateTimeFormat('en-NG', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(notification.createdAt)),
        createdAt: notification.createdAt,
        read: Boolean(notification.read),
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/read-all', async (req, res, next) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user.id, read: false },
      { $set: { read: true } },
    );
    return res.json({ message: 'Notifications marked as read.', updated: result.modifiedCount });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:notificationId/read', async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.notificationId)) {
    return res.status(404).json({ message: 'Notification not found.' });
  }
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.notificationId, userId: req.user.id },
      { $set: { read: true } },
      { returnDocument: 'after' },
    ).lean();
    if (!notification) return res.status(404).json({ message: 'Notification not found.' });
    return res.json({
      message: 'Notification marked as read.',
      notification: { id: notification._id.toString(), read: Boolean(notification.read) },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
