// ========================= backend/orders/orders.model.js =========================
const mongoose = require("mongoose");

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },
    products: [
      {
        productId: { type: String, required: true },
        quantity: { type: Number, required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        image: { type: String, required: true },

        // ✅ الحقول المطلوبة لحفظ اختيارات العميل
        chosenColor: { type: String, default: "" }, // اللون المختار
        chosenSize: { type: String, default: "" },  // المقاس المختار
        chosenCount: { type: String, default: "" }, // "العدد" المختار (نصي مثل: "2 قطع / 12 عبوة")
      },
    ],
    amount: { type: Number, required: true },
    shippingFee: { type: Number, required: true, default: 2 },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    country: { type: String, required: true },
    wilayat: { type: String, required: true },
    description: { type: String },
    // email: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["failed", "completed", "pending"],
      default: "pending",
    },
    currency: { type: String, required: true, enum: ["OMR", "AED"], default: "OMR" },
  },
  { timestamps: true }
);

const Order = mongoose.model("Order", OrderSchema);
module.exports = Order;
