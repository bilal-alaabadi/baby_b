const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // الفئة الرئيسية (الألعاب / مستلزمات المواليد)
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

    // التقييم
    rating: { type: Number, default: 0, min: 0, max: 5 },

    // كمية المخزون
    stock: { type: Number, required: true, min: 0, default: 0 },

    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// فهرسة لتحسين البحث
ProductSchema.index({ name: "text", mainCategory: 1, category: 1 });

const Products = mongoose.model("Product", ProductSchema);
module.exports = Products;
