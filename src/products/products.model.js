// ========================= backend/models/products.model.js =========================
const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    mainCategory: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },

    price: { type: Number, required: true, min: 0 },
    oldPrice: { type: Number, min: 0 },

    image: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "يجب إرسال صورة واحدة على الأقل",
      },
    },

    rating: { type: Number, default: 0, min: 0, max: 5 },

    // المخزون الإجمالي (يتم حسابه من الأوضاع المختلفة)
    stock: { type: Number, required: true, min: 0, default: 0 },

    size: { type: String, default: null, trim: true },
    count: { type: String, default: null, trim: true },

    // خيارات متعددة: اسم الخيار (count) + سعره + مخزونه (اختياري)
    countPrices: [
      {
        count: { type: String, trim: true, required: true },
        price: { type: Number, min: 0, required: true },
        stock: { type: Number, min: 0, required: false }, // يُستخدم فقط عند عدم وجود Matrix
        _id: false,
      }
    ],

    // ألوان بدون مخزون (توافق قديم)
    colors: { type: [String], default: [] },

    // ألوان بمخزون (عند الألوان فقط)
    colorsStock: [
      {
        color: { type: String, trim: true, required: true },
        stock: { type: Number, min: 0, required: true },
        _id: false,
      }
    ],

    // مصفوفة (ألوان × قطع) — سعر ومخزون لكل تركيبة
    variants: [
      {
        color: { type: String, trim: true, required: true },
        count: { type: String, trim: true, required: true },
        price: { type: Number, min: 0, required: true },
        stock: { type: Number, min: 0, required: true },
        _id: false,
      }
    ],

    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

ProductSchema.index({ name: "text", mainCategory: 1, category: 1 });

const Products = mongoose.model("Product", ProductSchema);
module.exports = Products;
