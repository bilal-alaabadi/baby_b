const express = require("express");
const Products = require("./products.model");
const Reviews = require("../reviews/reviews.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const { uploadImages } = require("../utils/uploadImage");
const multer = require("multer");

const router = express.Router();
const upload = multer(); // memory storage

// ====================== البحث ======================
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    const products = await Products.find({
      $or: [
        { name: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
      ],
    }).limit(20);
    res.status(200).json(products);
  } catch (error) {
    res.status(500).json({ message: "فشل البحث" });
  }
});

// ====================== رفع صور ======================
router.post("/uploadImages", async (req, res) => {
  try {
    const { images } = req.body; // base64[]
    if (!images || !Array.isArray(images)) {
      return res.status(400).send({ message: "يجب إرسال مصفوفة من الصور" });
    }
    const uploadedUrls = await uploadImages(images);
    res.status(200).send(uploadedUrls);
  } catch (error) {
    console.error("Error uploading images:", error);
    res.status(500).send({ message: "حدث خطأ أثناء تحميل الصور" });
  }
});

// ====================== إنشاء منتج ======================
// ========================= server/routes/products.js =========================
// ========================= server/routes/products.js =========================
router.post("/create-product", async (req, res) => {
  try {
    let {
      name,
      mainCategory,
      category,
      description,
      oldPrice,
      price,
      image,
      author,
      stock,        // مخزون عام (عند تعطيل الخيارات)
      size,
      count,
      colors,
      countPrices,  // [{count, price, stock?}]
    } = req.body;

    if (price !== undefined) price = Number(price);
    if (oldPrice !== undefined && oldPrice !== "") oldPrice = Number(oldPrice);
    else oldPrice = undefined;

    if (stock === undefined || stock === null || stock === "") {
      stock = 0;
    } else {
      stock = Math.floor(Number(stock));
    }

    const normalizeColors = (val) => {
      if (Array.isArray(val)) {
        return val.map((c) => String(c || "").trim()).filter(Boolean);
      }
      return String(val || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    };
    const colorsArr = normalizeColors(colors);

    const normalizeCountPrices = (val) => {
      if (!val) return [];
      let arr = val;
      if (typeof val === 'string') {
        try { arr = JSON.parse(val); } catch { arr = []; }
      }
      if (!Array.isArray(arr)) return [];
      return arr
        .map((item) => ({
          count: String(item?.count || '').trim(),
          price: Number(item?.price),
          stock: (item?.stock === undefined || item?.stock === null || item?.stock === '')
            ? undefined
            : Math.max(0, Math.floor(Number(item?.stock))),
        }))
        .filter((item) => item.count && !Number.isNaN(item.price) && item.price >= 0);
    };
    const countPricesArr = normalizeCountPrices(countPrices);

    if (!name || !mainCategory || !category || !description || price == null || !author) {
      return res.status(400).send({
        message:
          "جميع الحقول المطلوبة يجب إرسالها (الاسم، الفئة الرئيسية، النوع، الوصف، السعر، المؤلف)",
      });
    }

    if (Number.isNaN(price) || price < 0) {
      return res.status(400).send({ message: "السعر غير صالح" });
    }

    if (Number.isNaN(stock) || stock < 0) {
      return res.status(400).send({ message: "قيمة المخزون (stock) غير صالحة" });
    }

    if (!image || (Array.isArray(image) && image.length === 0)) {
      return res.status(400).send({ message: "يجب إرسال صورة واحدة على الأقل" });
    }

    const normalizedImages = Array.isArray(image) ? image : [image];

    const productData = {
      name: String(name).trim(),
      mainCategory: String(mainCategory).trim(),
      category: String(category).trim(),
      description: String(description).trim(),
      price,
      oldPrice,
      image: normalizedImages,
      author,
      stock,
      size: String(size || "").trim() || undefined,
      count: String(count || "").trim() || undefined,
      colors: colorsArr,
      countPrices: countPricesArr, // [{count, price, stock?}]
    };

    const newProduct = new Products(productData);
    const savedProduct = await newProduct.save();
    return res.status(201).send(savedProduct);
  } catch (error) {
    console.error("Error creating new product", error);
    return res.status(500).send({ message: "Failed to create new product" });
  }
});


// ====================== كل المنتجات ======================
// GET /api/products
// ========================= routes/products.js (GET /products) =========================
// ========================= routes/products.js (GET /products) =========================
router.get("/", async (req, res) => {
  try {
    const {
      mainCategory,   // الفئة الرئيسية
      category,       // التصنيف الفرعي
      availability,   // '', 'in', 'out'  ✅ فلتر المخزون
      minPrice,
      maxPrice,
      page = 1,
      limit = 10,
      sort = "createdAt:desc",
    } = req.query;

    const isAll = (v) =>
      v === undefined ||
      v === null ||
      String(v).trim() === "" ||
      String(v).trim().toLowerCase() === "all" ||
      String(v).trim() === "الكل";

    const filter = {};

    // التصنيفات (لا نحذفها)
    if (!isAll(mainCategory)) filter.mainCategory = String(mainCategory).trim();
    if (!isAll(category))     filter.category     = String(category).trim();

    // ✅ فلتر المخزون
    if (availability === 'in')   filter.stock = { $gt: 0 };
    if (availability === 'out')  filter.stock = { $eq: 0 };

    // السعر
    const min = parseFloat(minPrice);
    const max = parseFloat(maxPrice);
    if (!Number.isNaN(min) || !Number.isNaN(max)) {
      filter.price = {};
      if (!Number.isNaN(min)) filter.price.$gte = min;
      if (!Number.isNaN(max)) filter.price.$lte = max;
      if (Object.keys(filter.price).length === 0) delete filter.price;
    }

    // الترتيب
    let sortSpec = { createdAt: -1 };
    if (typeof sort === "string" && sort.includes(":")) {
      const [key, dir] = sort.split(":");
      if (key) sortSpec = { [key]: dir === "asc" ? 1 : -1 };
    }

    // صفحات
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (pageNum - 1) * limitNum;

    const totalProducts = await Products.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / limitNum) || 1;

    const products = await Products.find(filter)
      .sort(sortSpec)
      .skip(skip)
      .limit(limitNum)
      .populate("author", "email");

    // أعلى سعر ضمن الفلترة الحالية
    let highestPrice = null;
    const maxAgg = await Products.aggregate([
      { $match: filter },
      { $group: { _id: null, max: { $max: "$price" } } },
      { $project: { _id: 0, max: 1 } }
    ]);
    if (maxAgg && maxAgg.length > 0) highestPrice = maxAgg[0].max;

    res.status(200).send({ products, totalPages, totalProducts, highestPrice });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});


// ====================== المنتجات المرتبطة (ضعه قبل /:id) ======================
router.get("/related/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).send({ message: "Product ID is required" });

    const product = await Products.findById(id);
    if (!product) return res.status(404).send({ message: "Product not found" });

    const titleRegex = new RegExp(
      product.name
        .split(" ")
        .filter((word) => word.length > 1)
        .join("|"),
      "i"
    );

    const relatedProducts = await Products.find({
      _id: { $ne: id },
      $or: [{ name: { $regex: titleRegex } }, { category: product.category }],
    });

    res.status(200).send(relatedProducts);
  } catch (error) {
    console.error("Error fetching the related products", error);
    res.status(500).send({ message: "Failed to fetch related products" });
  }
});

// ====================== منتج واحد ======================
// ندعم /product/:id (للـfrontend) وكذلك /:id، لكن احرص أن يأتيان بعد /related/:id
router.get(["/product/:id", "/:id"], async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await Products.findById(productId).populate("author", "email username");
    if (!product) return res.status(404).send({ message: "Product not found" });

    const reviews = await Reviews.find({ productId }).populate("userId", "username email");

    res.status(200).send({ product, reviews });
  } catch (error) {
    console.error("Error fetching the product", error);
    res.status(500).send({ message: "Failed to fetch the product" });
  }
});

// ====================== تحديث منتج ======================
// ========================= backend/router (مقتطف التحديث) =========================
router.patch("/update-product/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const productId = req.params.id;

    let {
      name,
      mainCategory,
      category,
      description,
      price,
      oldPrice,
      image,       // مصفوفة/نص/غير موجود
      author,      // اختياري
      stock,       // اختياري
      size,        // اختياري
      count,       // اختياري
      colors,      // اختياري (مصفوفة أو "أحمر,أزرق")
      countPrices, // [{count, price, stock?}] أو نص JSON
    } = req.body;

    const priceNum    = price    !== undefined ? Number(price)    : undefined;
    const oldPriceNum = (oldPrice !== undefined && oldPrice !== "") ? Number(oldPrice) : undefined;
    const stockNum    = (stock !== undefined && stock !== "") ? Math.floor(Number(stock)) : undefined;

    const normalizeColors = (val) => {
      if (val === undefined) return undefined;
      if (Array.isArray(val)) return val.map(c => String(c || "").trim()).filter(Boolean);
      return String(val || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    };
    const colorsArr = normalizeColors(colors);

    const normalizeCountPrices = (val) => {
      if (val === undefined) return undefined;
      let arr = val;
      if (typeof val === "string") {
        try { arr = JSON.parse(val); } catch { arr = []; }
      }
      if (!Array.isArray(arr)) return [];
      return arr
        .map((item) => ({
          count: String(item?.count || "").trim(),
          price: Number(item?.price),
          stock:
            (item?.stock === undefined || item?.stock === null || item?.stock === "")
              ? undefined
              : Math.max(0, Math.floor(Number(item?.stock))),
        }))
        .filter((item) => item.count && !Number.isNaN(item.price) && item.price >= 0);
    };
    const countPricesArr = normalizeCountPrices(countPrices);

    if (!name || !mainCategory || !category || priceNum == null || !description) {
      return res.status(400).send({
        message: "جميع الحقول المطلوبة يجب إرسالها (الاسم، الفئة الرئيسية، النوع، الوصف، السعر)",
      });
    }

    if (Number.isNaN(priceNum) || priceNum < 0) {
      return res.status(400).send({ message: "السعر غير صالح" });
    }
    if (oldPriceNum !== undefined && (Number.isNaN(oldPriceNum) || oldPriceNum < 0)) {
      return res.status(400).send({ message: "السعر القديم غير صالح" });
    }
    if (stockNum !== undefined && (Number.isNaN(stockNum) || stockNum < 0)) {
      return res.status(400).send({ message: "قيمة المخزون (stock) غير صالحة" });
    }

    const toTrimOrNull = (v) => {
      if (v === undefined) return undefined;
      const s = String(v || "").trim();
      return s || null;
    };

    const updateData = {
      name: String(name).trim(),
      mainCategory: String(mainCategory).trim(),
      category: String(category).trim(),
      description: String(description).trim(),
      price: priceNum,
    };

    if (author      !== undefined) updateData.author   = author;
    if (oldPriceNum !== undefined) updateData.oldPrice = oldPriceNum;
    if (size        !== undefined) updateData.size     = toTrimOrNull(size);   // ← سيصبح null لو فاضي
    if (count       !== undefined) updateData.count    = toTrimOrNull(count);  // ← سيصبح null لو فاضي
    if (colorsArr   !== undefined) updateData.colors   = colorsArr;

    if (image !== undefined) {
      let normalizedImages = [];
      if (Array.isArray(image)) {
        normalizedImages = image.map((u) => String(u || "").trim()).filter(Boolean);
      } else if (typeof image === "string") {
        const one = image.trim();
        if (one) normalizedImages = [one];
      }
      updateData.image = normalizedImages;
    }

    if (countPricesArr !== undefined) {
      updateData.countPrices = countPricesArr;

      const sumOptionStock = countPricesArr
        .map(x => (typeof x.stock === "number" && x.stock >= 0 ? x.stock : 0))
        .reduce((a, b) => a + b, 0);

      const anyOptionHasStock = countPricesArr.some(x => typeof x.stock === "number");
      if (anyOptionHasStock) {
        updateData.stock = sumOptionStock;
      } else if (stockNum !== undefined) {
        updateData.stock = stockNum;
      }
    } else if (stockNum !== undefined) {
      updateData.stock = stockNum;
    }

    const updatedProduct = await Products.findByIdAndUpdate(
      productId,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedProduct) {
      return res.status(404).send({ message: "المنتج غير موجود" });
    }

    return res.status(200).send({
      message: "تم تحديث المنتج بنجاح",
      product: updatedProduct,
    });
  } catch (error) {
    console.error("خطأ في تحديث المنتج", error);
    return res.status(500).send({
      message: "فشل تحديث المنتج",
      error: error.message,
    });
  }
});



// ====================== حذف منتج ======================
router.delete("/:id", async (req, res) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Products.findByIdAndDelete(productId);

    if (!deletedProduct) {
      return res.status(404).send({ message: "Product not found" });
    }

    await Reviews.deleteMany({ productId });
    res.status(200).send({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting the product", error);
    res.status(500).send({ message: "Failed to delete the product" });
  }
});

module.exports = router;
