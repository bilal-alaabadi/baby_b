// ========================= backend/models/products.model.js =========================
const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // الفئة الرئيسية
    mainCategory: { type: String, required: true, trim: true },

    // النوع/التصنيف الفرعي
    category: { type: String, required: true, trim: true },

    description: { type: String, required: true, trim: true },

    price: { type: Number, required: true, min: 0 },

    oldPrice: { type: Number, min: 0 },

    // صور المنتج
    image: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "يجب إرسال صورة واحدة على الأقل",
      },
    },

    rating: { type: Number, default: 0, min: 0, max: 5 },

    // كمية المخزون
    stock: { type: Number, required: true, min: 0, default: 0 },

    // مقاس واحد (اختياري)
    size: { type: String, default: null, trim: true },

    // العدد (اختياري) — مثل "2 قطع" أو "12 عبوة"
    count: { type: String, default: null, trim: true },

    // الألوان (اختياري)
    colors: {
      type: [String],
      default: [],
    },

    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// فهرسة لتحسين البحث
ProductSchema.index({ name: "text", mainCategory: 1, category: 1 });

const Products = mongoose.model("Product", ProductSchema);
module.exports = Products;
