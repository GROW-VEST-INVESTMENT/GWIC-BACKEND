const mongoose = require('mongoose');

const connectCommissionSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectPartner', required: true, index: true },
    referralId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectReferral', required: true },
    type: { type: String, enum: ['registration'], required: true },
    amountKobo: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', required: true },
    reviewNote: { type: String, trim: true, maxlength: 500, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

connectCommissionSchema.index({ referralId: 1, type: 1 }, { unique: true });
connectCommissionSchema.index({ partnerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ConnectCommission', connectCommissionSchema);
